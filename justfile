set dotenv-load := false

default:
    @just --list

# Install a standalone copy of this checkout and prepare the Chrome extension.
install:
    npm install --global --ignore-scripts --install-links .
    node "$(npm root --global)/tactiq-live-channel/bin/tactiq-live.js" setup

# Remove the CLI only; preserve runtime data and the manual Chrome registration.
uninstall:
    npm uninstall --global tactiq-live-channel
