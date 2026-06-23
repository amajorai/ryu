# Contributing to @ryu/sdk

Thanks for your interest in improving **@ryu/sdk**, an open-source component of
[Ryu](https://ryuhq.com).

## License of contributions

@ryu/sdk is licensed under **Apache-2.0**. By submitting a contribution you agree that your work is
provided under that same license and that you have the right to submit it. We may ask you to
sign off your commits (`git commit -s`) under the
[Developer Certificate of Origin](https://developercertificate.org/).

## Source of truth

This unit is developed in Ryu's monorepo, which is the canonical source. The public repository is
generated one-way from the monorepo, so it is read-only at the file level: open issues and pull
requests here and a maintainer will land accepted changes upstream, then sync them back out.

## Development

```bash
bun install
bun test
bun run build
```

## Pull requests

- Keep changes focused — one logical change per PR.
- Add or update tests for any behaviour change.
- Make sure the build, tests, and linters pass before requesting review.
- Explain the motivation and any trade-offs in the description.

## Reporting bugs & security issues

Open a GitHub issue for ordinary bugs. For security vulnerabilities, do **not** open a public
issue — follow [SECURITY.md](./SECURITY.md).
