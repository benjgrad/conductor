-- M1-T07 (U-032): the Claude Code CLI version the daemon reported in `register`
-- (`claude --version`, U-015), so stream-json drift can be correlated to a CLI version.
-- null = the daemon couldn't run the CLI, or hasn't registered since this column was added.

-- Up Migration

ALTER TABLE machine ADD COLUMN claude_code_version text;

-- Down Migration

ALTER TABLE machine DROP COLUMN claude_code_version;
