# Running the broker without a service manager

This image has no systemd user manager and no launchd. Squire does not
install a unit, and it does not supervise or restart the broker.

1. The entrypoint writes a fixture session and idles. It does not start a
   broker.
2. The first `mcp server` tool call starts one broker, waits for it, and
   then serves the call. Concurrent clients share a start lock, so they
   produce exactly one broker.
3. If that broker dies, nothing restarts it until the next client call,
   which starts exactly one again.
4. If the broker fails to come up, that call returns the broker's own
   output and leaves no extra processes.

`systemctl` in the image only appends the invocation to
`/var/log/systemctl-calls.log` and exits 1. It does not start a broker.

The entrypoint writes a local fixture session and a loopback vault stub so
`list_credentials` can succeed. The fixture account is `container-broker-test`
and its API base is `http://127.0.0.1:18765`. It is not a real Squire account.
Sign-in on machines like this uses the phone link.

Build the image with `verify.sh` from the repository root. That script packs
the local mcp package into the image (the published npm tarball does not
include this on-demand start until it ships):

```
docs/container-broker/verify.sh
```

Or, after `verify.sh` has prepared the build context:

```
docker build -t ts-container-broker:test /tmp/ts-container-broker-ctx
docker rm -f ts-container-broker-runtime
docker run -d --name ts-container-broker-runtime ts-container-broker:test
```

There is no `--restart` policy. The container idles; the broker is not the
main process.

First tool call (starts one broker, `list_credentials` succeeds):

```
docker exec ts-container-broker-runtime node /opt/squire/client.mjs
```

Broker count:

```
docker exec ts-container-broker-runtime ps -eo pid,ppid,args
```

Two concurrent clients still produce one broker:

```
docker exec ts-container-broker-runtime sh -c 'node /opt/squire/client.mjs & node /opt/squire/client.mjs & wait'
```

Kill the broker; it must not come back until the next client:

```
docker exec ts-container-broker-runtime sh -c 'pid=$(ps -eo pid,args | awk "/dist\\/bin.js broker/{print \$1; exit}"); kill -9 "$pid"'
docker exec ts-container-broker-runtime ps -eo pid,args
docker exec ts-container-broker-runtime node /opt/squire/client.mjs
```
