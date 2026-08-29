# telemetry

Owned by Engineer 1. Ingest at `POST /internal/telemetry/:serverId`, then rolling window
aggregation into `world_events_rollup`.

Raw events are not stored. Everything downstream reads rollups.
