# Webhook delivery: design note

## Retries
The retry wrapper caps backoff at 30 seconds and uses full jitter.
A delivery is attempted at most 8 times before it is parked.

## Idempotency
Idempotency keys are stored for 24 hours in Redis.
A repeated key returns the original response and does not enqueue a second job.

## Migration
The migration adds a nullable column, so it can ship before the application code.
A backfill job fills the column within 6 hours of deploy.

## Performance
Webhook delivery p99 latency dropped from 900ms to 250ms after the queue split.
The change assumes payload size stays under 256 KB.

## Operations
Failed deliveries land in a dead-letter queue reviewed each weekday.
Load tests at 3x peak traffic showed no dropped events.

## Risk
The fragile assumption is that Redis eviction will not delete a live idempotency key.
If eviction rises, duplicate jobs become possible until the key TTL is moved to a durable store.
