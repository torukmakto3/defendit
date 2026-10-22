# Harbor

Harbor is a local index for a team's notes. It runs on one machine and answers search from that machine's disk.

Harbor keeps each note as a plain Markdown file. Search reads those files and builds an in-memory index when the process starts.

The index assumes each workspace stays under 2,000 notes. That assumption is what lets the whole index fit in one process without a separate search service.

A note is visible to everyone on the workspace. Harbor does not apply per-person permissions in this version.

Restarting Harbor rebuilds the index from disk. Notes added while it is stopped show up on the next start.
