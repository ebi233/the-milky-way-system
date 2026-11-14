Vendored from SAOS-3624/dsh-see-now v0.0.6, commit 916354d36e58fdd843fff96284ff7c985bd00020.
https://github.com/SAOS-3624/dsh-see-now/tree/916354d36e58fdd843fff96284ff7c985bd00020

capture.js and png.js are unmodified upstream modules, under Apache-2.0; LICENSE and NOTICE accompany them.
The Paopao adapter uses captureArgs and encodePng. It replaces the process lifecycle with a bounded, hidden, one-frame capture and adds fixed Windows executable resolution, caller-bound owner access and existing Flash observation.
Upstream background loop, floating chat, voice, microphone, camera, file/URL capture, and model wakeups are not registered or run.
