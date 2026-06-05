# .github/workflows/roster-lookup.yml
name: Roster Lookup

on:
  workflow_dispatch:
    inputs:
      grade_id:
        description: 'Grade ID from discoverGrade.ladder'
        required: false
        default: '5afff92b'
        type: string
      mode:
        description: >
          1 - Full re-fetch: fetch publicProfileTeams for ALL players in DB (ignores existing data, slowest)
          2 - Fill gaps: fetch only players missing teams data (fastest first run, skips already-fetched)
          3 - Local lookup only: cross-reference stored data against grade, no API calls (instant)
        required: false
        default: '3'
        type: choice
        options:
          - '1 - Full re-fetch (all players, slow ~30min)'
          - '2 - Fill gaps (missing players only, incremental)'
          - '3 - Local lookup only (instant, no API calls)'
      min_year:
        description: 'Minimum season year to consider (players with U13/U14 history before this are excluded)'
        required: false
        default: '2024'
        type: string
      concurrency:
        description: 'Concurrent API requests during teams fetch (lower = safer)'
        required: false
        default: '20'
        type: string

jobs:
  roster-lookup:
    runs-on: ubuntu-latest
    timeout-minutes: 360
    permissions:
      contents: write

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Build args
        id: args
        run: |
          ARGS="--grade=${{ github.event.inputs.grade_id }}"
          ARGS="$ARGS --min-year=${{ github.event.inputs.min_year }}"
          ARGS="$ARGS --concurrency=${{ github.event.inputs.concurrency }}"
          MODE="${{ github.event.inputs.mode }}"
          if [[ "$MODE" == 1* ]]; then
            ARGS="$ARGS --all-ages --force-fetch"
          elif [[ "$MODE" == 2* ]]; then
            ARGS="$ARGS --all-ages --fetch-teams"
          fi
          # Mode 3 = no fetch flags, local lookup only
          echo "args=$ARGS" >> $GITHUB_OUTPUT
          echo "Running with: $ARGS"

      - name: Configure git
        run: |
          git config user.name  "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

      - name: Run roster lookup
        run: node roster-lookup.js ${{ steps.args.outputs.args }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}

      - name: Commit results
        run: |
          git add players/ roster-results/
          if git diff --staged --quiet; then
            echo "No changes to commit"
          else
            GRADE="${{ github.event.inputs.grade_id }}"
            git commit -m "Roster lookup: grade ${GRADE} ($(date -u +%Y-%m-%d))"
            git push
          fi
