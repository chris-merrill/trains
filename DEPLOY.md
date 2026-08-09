# Deploy to transit-cm.web.app

Cloud Shell has already cloned this repo and logged you in. One command:

```sh
firebase deploy --project transit-cm --only hosting
```

That's it — the site updates about a minute after "Deploy complete!".

(Hosting only: the getSchedule / refreshSchedule Cloud Functions are untouched
and keep refreshing schedule data on their own.)
