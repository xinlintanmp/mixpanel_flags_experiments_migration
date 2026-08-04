# Statsig Migration Guide - Native SDK route 
29 Jun 2026

## Outline of what this does
1. authenticate statsig account against the API
    For programmatic access, you can leverage Statsig's public APIs or Console API to fetch flag data
2. also input mixpanel details 
    mixpanel service account 
3. select and list all flags

## What is included 
### this is in buildRuleset() function
1. rollout splits
2. variant splits
3. basic structure

## What is not included
### Currently these are things that do not have a Mixpanel equivalent. they are Statsig rules like:
1. User attribute targeting (country, email, custom properties)
2. Segment/cohort conditions
3. Progressive rollouts
4. A/B test assignment rules
5. User ID overrides
6. Environment targeting
7. Custom conditions

{
  name: null,
  runtime_evaluation_rule: null,     // ❌ No targeting rules
  runtime_event_rule: null,          // ❌ No event-based triggers
  cohort_hash: null,                 // ❌ No cohort/segment targeting
  variant_override: null,            // ❌ No user overrides
  rollout_percentage: rolloutPct,    // ✅ Only this is migrated
  variant_splits: vs                 // ✅ Only even splits
}

## Todo
1. DONE/the migration html files are way too long, need to clean up and modularise
2. DONE/test experiment 
3. DONE/test dynamic config
4. test feature gate with customIDs? (group analytics), stableID (device ID)
5. fix dry run mode
6. export and import the exposure events as $experiment_started
7. openFeature route - this will be a different flow 
8. DONE/repeat the same for Remote Config
    Firebase Remote Config tool: `firebase_mixpanel_migration.html` + `firebase_migration.js`.
    Parameters only — boolean params become gates, string/number/JSON params become value flags.
    Only Firebase percentage rollouts migrate; all other condition rules (OS, country, app version,
    user property, audience, installation ID, custom signals) are dropped and reported in step 3.
    Firebase A/B Testing experiments are NOT migrated — firebaseabt.googleapis.com is a private,
    allowlisted API with no public REST reference.
    Auth is an OAuth2 bearer token (`gcloud auth print-access-token`), which expires hourly.