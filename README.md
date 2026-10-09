# pi-read-delta

A [Pi](https://pi.dev) package that adds `read_delta`, a tool that shows how a file changed since its latest comparable `read` call.

## Install

After publishing to npm:

```bash
pi install npm:pi-read-delta
```

For local development:

```bash
pi --extension /Users/Shared/devtools-config/pi/agent/extensions/pi-read-delta
```

## `read_delta`

```text
read_delta({ path })
```

The tool deliberately accepts only `path`. It finds the newest successful `read` of the same resolved file on the active session branch and automatically reuses that call's `offset` and `limit` values. It then returns a unified diff between that previously read range and the current range at the same location; hunk locations use the original file's line numbers.

Call `read` first. An offset- or limit-based read is a valid baseline. If the prior read was cut by Pi's 2,000-line/50 KiB output cap, read an image, or was made before this extension was loaded, `read_delta` returns an explanation instead of an unreliable diff.

The extension stores baseline text in the prior `read` result's `details`. It is not sent to the model as an additional message, and follows Pi session branches and resumes.

Diffs are limited to 2,000 lines or 50 KiB. If the change is larger, use `read` for the relevant range.
