# Running the broker in a container

The image has no systemd. Its default entrypoint is `entrypoint.sh`. That
process runs `node .../dist/bin.js broker` and exits with the broker's status.
It does not restart the broker. `docker run --restart=on-failure` does.

`docker kill` is a manual stop. The restart policy does not run. Kill the
broker from inside the container. The entrypoint then exits 137 and Docker
starts the container again. One broker is running after that restart.

`systemctl` in the image only appends the invocation to
`/var/log/systemctl-calls.log` and exits 1. It does not start a broker.

The entrypoint writes a local fixture session so `operate_start` is allowed
to open a page. The fixture account is `container-broker-test` and its API
base is `http://127.0.0.1:9`. It is not a real Squire account. A real account
still comes from `connect` on a machine with systemd or launchd.

Build from this directory:

```
docker build -t ts-container-broker:test -f docs/container-broker/Dockerfile docs/container-broker
```

Run, from a checkout of this repository:

```
docker rm -f ts-container-broker-runtime
docker run -d --name ts-container-broker-runtime --restart=on-failure ts-container-broker:test
```

Public page, no account:

```
docker exec ts-container-broker-runtime node /opt/squire/client.mjs
```

Broker count and Docker's restart counter:

```
docker exec ts-container-broker-runtime ps -eo pid,ppid,args
docker inspect ts-container-broker-runtime --format 'status={{.State.Status}} exit={{.State.ExitCode}} restart={{.RestartCount}}'
```

Kill the broker, not the container:

```
docker exec ts-container-broker-runtime sh -c 'kill -9 "$(cat /tmp/broker.pid)"'
```

Wait until inspect shows `status=running` and a higher `restart` count, then
repeat the client command and `ps`. The client should open `https://example.com`
again, and `ps` should show one `dist/bin.js broker` process.
