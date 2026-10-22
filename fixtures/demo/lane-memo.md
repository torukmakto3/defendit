# Lane

Lane is a review queue for short design packets. A reviewer opens one packet, leaves a decision, and the queue moves to the next.

The design assumes a reviewer finishes a packet in 12 minutes. One queue worker then covers a team of 40 people submitting one packet a day.

Packets are Markdown. Lane stores the decision next to the file hash so a later edit is visible.

Lane does not assign a packet twice. If a reviewer stops halfway, the packet returns to the queue after 12 minutes.

The 12-minute assumption is the load-bearing one. A slower review means the single worker falls behind.
