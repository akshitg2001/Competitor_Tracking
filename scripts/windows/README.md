# Market Pulse local automation

Market Pulse runs entirely on this Windows computer. It does not need cloud hosting and it does not use AI tokens during routine scans.

## Daily use

- Double-click **Market Pulse** on the desktop.
- The shortcut starts the local services if needed, waits for both health checks, and opens `http://localhost:5173/`.
- Closing the browser does not stop the services. They restart automatically after a service crash and start again at Windows sign-in.

## Automatic scans

- Monday, Wednesday and Friday at 9:00 AM local time.
- Brands are scanned sequentially: ONYC, Starkidz, KATS, then Aretto.
- If a brand has already used its one full refresh that day, it is skipped.
- A database and JSON snapshot backup is created before every scheduled run. The newest 30 backups are retained.
- A missed run starts when the computer next becomes available. The task is also permitted to wake the computer, subject to the device's Windows power settings.

## Maintenance commands

Run these from PowerShell in the project folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\market-pulse.ps1 status
powershell -ExecutionPolicy Bypass -File .\scripts\windows\market-pulse.ps1 start
powershell -ExecutionPolicy Bypass -File .\scripts\windows\market-pulse.ps1 stop
```

To rebuild and reinstall the automation after an application update:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-market-pulse.ps1
```

To remove the scheduled tasks and desktop shortcut while preserving all source code and collected data:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-market-pulse.ps1 -Uninstall
```

Runtime logs are saved under `data/logs`. Scan status is saved in `data/scheduler-status.json` and service state under `data/runtime`.
