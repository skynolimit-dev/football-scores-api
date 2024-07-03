#!/bin/bash

# Get the current directory
export CURRENT_DIR=$(pwd)

# Start the Firestore emulator
cd ~/dev/firebase/firebase-emulator-football-scores-api-dev
./start.sh &
export FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'

# Start the API server
cd $CURRENT_DIR
nodemon server.js