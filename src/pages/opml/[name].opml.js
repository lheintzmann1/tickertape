// Publishes each OPML file as-is, so the lists can be subscribed to from any other reader
// and the editor can load them in offline mode.
import { loadSite } from '../../lib/site-data.js';

export function getStaticPaths() {
  return loadSite().views.map((view) => ({ params: { name: view.file.replace(/\.opml$/i, '') }, props: { view } }));
}

export function GET({ props }) {
  return new Response(props.view.raw, { headers: { 'Content-Type': 'text/x-opml; charset=utf-8' } });
}
