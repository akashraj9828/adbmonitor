# ADB Monitor

A dependency-free Node.js service with an htop-style web dashboard for Android devices connected through ADB.

## Run

Make sure `adb` is installed and the device is visible to it:

```sh
adb devices
npm start
```

Open [http://localhost:3000](http://localhost:3000). Use **Refresh** to discover devices connected after the page loads, then select a device from the target dropdown.

The service can also be configured with:

```sh
PORT=8080 POLL_INTERVAL=1000 npm start
```

`POLL_INTERVAL` is in milliseconds and defaults to 2000. Increasing it to 5000 or 10000 reduces ADB and device overhead further. The dashboard uses Server-Sent Events, so metrics update without polling from the browser.

The monitor avoids repeatedly running the more expensive `dumpsys cpuinfo` command and caches the device's core count. All processes, including ADB helper processes, remain visible in the table.

For collector validation, call `/api/compare?serial=<device-serial>` twice. It compares the current `ps` results with a lightweight `/proc` snapshot, including process counts, matched PIDs, and RSS differences. The first call seeds the `/proc` CPU snapshot; the second call can be used to compare CPU deltas once the `/proc` collector is wired into the dashboard.

## Data collected

- CPU usage from `/proc/stat` and `/proc/<pid>/stat`, with logical core count from `nproc`
- RAM totals and availability from `/proc/meminfo`
- Process CPU, memory percentage, RSS, PID, UID-derived user, state, and name from `/proc`

The dashboard does not invoke `ps`; the comparison endpoint is the only place that runs it for validation.
