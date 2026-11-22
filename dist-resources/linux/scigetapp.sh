#!/usr/bin/env sh

# calculate application path from this script's path
SELF_DIR=$(dirname $(realpath $0))
JLAB_PATH=$(realpath "$SELF_DIR"/../../scigetapp)
$JLAB_PATH "$@"
exit $?
