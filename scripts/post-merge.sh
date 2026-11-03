#!/bin/bash
set -e
npm install
npm run push --workspace=@workspace/db
