# .github/workflows/test-schema-fields.yml
name: Test Schema Fields

on:
  workflow_dispatch:
    inputs:
      teamId:
        description: 'Team ID (from games/bv/ h or a field)'
        required: false
        type: string
      orgId:
        description: 'Org ID (from sports-index.json orgId)'
        required: false
        type: string
      gradeId:
        description: 'Grade ID (from sports-index.json grades[])'
        required: false
        type: string
      seasonId:
        description: 'Season ID (from sports-index.json)'
        required: false
        type: string

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 1
          sparse-checkout: |
            scripts/test-schema-fields.js
          sparse-checkout-cone-mode: false

      - name: Test schema fields
        run: |
          ARGS=""
          if [ -n "${{ inputs.teamId }}"   ]; then ARGS="$ARGS --teamId=${{ inputs.teamId }}"; fi
          if [ -n "${{ inputs.orgId }}"    ]; then ARGS="$ARGS --orgId=${{ inputs.orgId }}"; fi
          if [ -n "${{ inputs.gradeId }}"  ]; then ARGS="$ARGS --gradeId=${{ inputs.gradeId }}"; fi
          if [ -n "${{ inputs.seasonId }}" ]; then ARGS="$ARGS --seasonId=${{ inputs.seasonId }}"; fi
          node scripts/test-schema-fields.js $ARGS
