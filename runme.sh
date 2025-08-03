#!/usr/bin/env bash
podman \
	build \
		--build-arg user=1000 \
		-t macports-webhook-redelivery \
		. \
	&& \

thisdir=$(dirname "$(greadlink -f "${BASH_SOURCE[0]}")")

declare -A hooks=([prbot]=15098007 [buildbot]=10498883 [trac]=10414556)
declare -A state=([prbot]="$thisdir/state/prbot" [buildbot]="$thisdir/state/buildbot" [trac]="$thisdir/state/trac")

TOKEN=$(<"$thisdir/token")

for component in "${!hooks[@]}"; do
	touch "${state[$component]}"
	podman \
		run \
			--rm \
			-v "${state[$component]}:/tmp/home/last" \
			--env=LAST_REDELIVERY_FILE=/tmp/home/last \
			--env=REPO_OWNER=macports \
			--env=REPO=macports-ports \
			--env=HOOK_ID="${hooks[$component]}" \
			--env=TOKEN="$TOKEN" \
			-it localhost/macports-webhook-redelivery:latest
done

