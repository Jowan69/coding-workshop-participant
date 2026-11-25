// CloudFront Function, viewer-request, default behaviour only (never the /api behaviours).
// A path without a file extension is not a file in the bucket, it is an address inside the
// single-page app (/projects/5), so serve index.html for it. The app then turns the path
// into its hash route (/#/projects/5). Files (/assets/index-abc123.js, /favicon.svg) pass
// through untouched, so a missing file is still a real 404.
function handler(event) {
  var request = event.request;
  var lastSegment = request.uri.substring(request.uri.lastIndexOf('/') + 1);
  if (lastSegment.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}
