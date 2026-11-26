//! A small RFC 4180 reader for password exports.
//!
//! Cells are data only. Nothing here interprets a leading `=`, `+`, `-` or
//! `@` (spreadsheet formula characters), and no error carries a cell: a file
//! without a header row would otherwise put a credential into an error text.

/// Why a file could not be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CsvError {
    /// A quoted cell never closes. `record` counts from 1.
    UnterminatedQuote { record: usize },
    /// More than the allowed number of records.
    TooManyRecords,
}

/// Parse `text` into records of cells. A leading byte order mark and blank
/// lines are dropped. A quoted cell may hold commas, line breaks and doubled
/// quotes. At most `max_records` records are read.
pub(super) fn parse(text: &str, max_records: usize) -> Result<Vec<Vec<String>>, CsvError> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut records: Vec<Vec<String>> = Vec::new();
    let mut record: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut in_quotes = false;
    // Whether the next character starts a cell (so a quote opens it).
    let mut at_cell_start = true;
    // Whether the current cell was quoted (an empty quoted cell still counts).
    let mut cell_quoted = false;
    let mut chars = text.chars().peekable();

    while let Some(c) = chars.next() {
        if in_quotes {
            if c != '"' {
                cell.push(c);
            } else if chars.peek() == Some(&'"') {
                chars.next();
                cell.push('"');
            } else {
                in_quotes = false;
            }
            continue;
        }
        match c {
            '"' if at_cell_start => {
                in_quotes = true;
                cell_quoted = true;
                at_cell_start = false;
            }
            ',' => {
                record.push(std::mem::take(&mut cell));
                at_cell_start = true;
                cell_quoted = false;
            }
            '\r' | '\n' => {
                if c == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                }
                end_record(
                    &mut records,
                    &mut record,
                    &mut cell,
                    cell_quoted,
                    max_records,
                )?;
                at_cell_start = true;
                cell_quoted = false;
            }
            _ => {
                cell.push(c);
                at_cell_start = false;
            }
        }
    }
    if in_quotes {
        return Err(CsvError::UnterminatedQuote {
            record: records.len() + 1,
        });
    }
    end_record(
        &mut records,
        &mut record,
        &mut cell,
        cell_quoted,
        max_records,
    )?;
    Ok(records)
}

/// Close the current record. A line with nothing on it is not a record.
fn end_record(
    records: &mut Vec<Vec<String>>,
    record: &mut Vec<String>,
    cell: &mut String,
    cell_quoted: bool,
    max_records: usize,
) -> Result<(), CsvError> {
    if record.is_empty() && cell.is_empty() && !cell_quoted {
        return Ok(());
    }
    record.push(std::mem::take(cell));
    if records.len() >= max_records {
        return Err(CsvError::TooManyRecords);
    }
    records.push(std::mem::take(record));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(text: &str) -> Vec<Vec<String>> {
        parse(text, 100).unwrap()
    }

    #[test]
    fn reads_plain_and_quoted_cells_with_either_line_ending() {
        assert_eq!(
            rows("a,b,c\r\n1,\"two, 2\",3\n"),
            vec![vec!["a", "b", "c"], vec!["1", "two, 2", "3"]]
        );
        assert_eq!(rows("a,b\r1,2"), vec![vec!["a", "b"], vec!["1", "2"]]);
    }

    #[test]
    fn keeps_line_breaks_and_doubled_quotes_inside_quotes() {
        assert_eq!(
            rows("name,note\nx,\"line one\nline \"\"two\"\"\"\n"),
            vec![vec!["name", "note"], vec!["x", "line one\nline \"two\""]]
        );
    }

    #[test]
    fn drops_the_byte_order_mark_and_blank_lines_but_keeps_empty_cells() {
        assert_eq!(
            rows("\u{feff}a,b\n\n,\n\"\"\n\n"),
            vec![vec!["a", "b"], vec!["", ""], vec![""]]
        );
    }

    #[test]
    fn formula_characters_and_stray_quotes_are_plain_text() {
        assert_eq!(
            rows("=1+1,@SUM(A1),+x,-y,pa\"ss"),
            vec![vec!["=1+1", "@SUM(A1)", "+x", "-y", "pa\"ss"]]
        );
    }

    #[test]
    fn an_open_quote_and_too_many_records_are_refused() {
        assert_eq!(
            parse("a,b\n1,\"never closed\n", 100),
            Err(CsvError::UnterminatedQuote { record: 2 })
        );
        assert_eq!(parse("a\nb\nc\n", 2), Err(CsvError::TooManyRecords));
        assert_eq!(parse("a\nb\n", 2).map(|rows| rows.len()), Ok(2));
    }
}
