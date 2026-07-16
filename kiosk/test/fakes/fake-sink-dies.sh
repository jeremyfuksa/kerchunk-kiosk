#!/usr/bin/env bash
# Fake audio sink that closes ITS end of stdin but stays alive — the aplay
# failure mode (ALSA device yanked, HDMI renegotiation) where the pipe breaks
# while the stream object on the Node side still reports writable=true. The
# engine's next PCM write then raises EPIPE asynchronously; without an 'error'
# listener on sink.stdin that event is uncaught and kills the whole backend.
exec 0<&-
sleep 5
