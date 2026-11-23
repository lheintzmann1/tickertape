import { loadSite, viewPayload } from '../../lib/site-data.js';

export function getStaticPaths() {
  return loadSite().views.map((view) => ({ params: { view: view.slug }, props: { view } }));
}

export function GET({ props }) {
  return new Response(JSON.stringify(viewPayload(props.view)), { headers: { 'Content-Type': 'application/json' } });
}
