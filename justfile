set dotenv-load := false

default:
    @just --list

# Install a standalone copy of this checkout and prepare the Chrome extension.
install:
    npm install --global --ignore-scripts --install-links .
    node "$(npm root --global)/live-support/bin/live-support.js" setup

# Remove the CLI only; preserve runtime data and the manual Chrome registration.
uninstall:
    npm uninstall --global live-support
