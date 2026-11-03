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

`POLL_INTERVAL` is in milliseconds and defaults to 2000. The dashboard uses Server-Sent Events, so metrics update without polling from the browser.

## Data collected

- CPU usage from `/proc/stat` and logical core count from `nproc`
- RAM totals and availability from `/proc/meminfo`
- Process CPU, memory percentage, RSS, PID, user, and name from Android `ps`

The process command falls back to the basic `ps -A` format for older Android builds.
