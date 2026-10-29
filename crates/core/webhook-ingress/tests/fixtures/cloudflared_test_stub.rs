use std::time::Duration;

fn main() {
    if std::env::var_os("RYU_CLOUDFLARED_TEST_SECRET").is_some() {
        eprintln!("cloudflared inherited a secret-like parent environment variable");
        std::process::exit(3);
    }

    let args: Vec<String> = std::env::args().skip(1).collect();
    let expected = [
        "tunnel",
        "--no-autoupdate",
        "--url",
        "http://localhost:7980",
    ];
    let args_match = args.iter().map(String::as_str).eq(expected);
    if !args_match {
        eprintln!("unexpected cloudflared arguments: {args:?}");
        std::process::exit(2);
    }

    eprintln!("Quick Tunnel ready at https://process-test.trycloudflare.com");
    std::thread::park_timeout(Duration::from_secs(60));
}
