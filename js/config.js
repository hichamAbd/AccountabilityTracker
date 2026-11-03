// Which repository holds the data, and on which branch.
// Served from https://<owner>.github.io/ the owner and repo are detected automatically.
const host = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
const firstSegment = location.pathname.split('/').filter(Boolean)[0];

export const CFG = {
  owner: host ? host[1] : 'hichamAbd',
  repo: host
    ? (firstSegment && !firstSegment.includes('.') ? firstSegment : `${host[1]}.github.io`)
    : 'AccountabilityTracker',
  // Data lives on its own branch so logging never triggers a GitHub Pages rebuild.
  branch: 'data',
};
