Drop scheduler-client.js into this folder.

The appointment scheduler reads this file at startup and runs it in a
sandbox to get the RenewedVisionScheduler global. Without this file, the
"Assigned rep" line in the notification email will be blank (but
appointments will still book normally).

Grab the file from the <script src="..."> URL in the scheduler HTML
snippet — download whatever the src is pointing at — and save it here as
`scheduler-client.js`. Then commit it to git:

    git add lib/scheduler-client.js
    git commit -m "Add RV scheduler client script"
    git push

If the file lives at a URL that's stable, you could instead fetch it at
build time, but keeping a pinned copy in the repo is simpler and means the
site doesn't break if the upstream URL changes.
