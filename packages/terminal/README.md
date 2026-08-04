# Enhanced terminal tools

`oc-enhanced-terminal` exposes `shell` for finite foreground work and `background_process` for managed long-running processes.

## Same-call recovery

The tools retry at most once and only when the first attempt provably could not execute command code:

- PowerShell rejected a leading quoted Windows executable because the `&` call operator was missing. The retry adds only `&`; executable and arguments are unchanged.
- The operating system rejected process creation with a transient resource code (`EAGAIN`, `EBUSY`, `EMFILE`, `ENFILE`, or `EPERM`). The identical command is retried after 100 ms.

Ordinary nonzero exits, timeouts, cancellations, readiness failures, and commands that may have performed side effects are never replayed.

## High-information background start

`start` includes a bounded settlement period and startup output in its first response. Optional `ready_output`, `ready_port`, or `ready_url` can prove readiness inside that same operation; `startup_timeout_ms` is bounded to 30 seconds. An early exit is reported immediately with captured logs. Stop operations confirm termination within a bounded deadline, and cleanup refreshes lifecycle state before removing records.

The public lifecycle remains intentionally small: started/ready, running, or exited/failed. Agents should batch independent lifecycle operations rather than polling.
