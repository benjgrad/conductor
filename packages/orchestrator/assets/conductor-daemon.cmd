@echo off
rem conductor-daemon entry on Windows (MR-T15): runs the native binary next to it.
"%~dp0conductor-daemon.exe" %*
exit /b %ERRORLEVEL%
