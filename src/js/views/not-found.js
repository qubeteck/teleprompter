import { emptyState } from '../ui.js';

export function notFoundView(ctx) {
  const element = emptyState({
    iconName: 'search',
    title: 'That page is not part of the studio',
    description: 'The link may be incomplete or the screen may have moved. Your scripts are still safe in the local library.',
    actions: [
      { label: 'Open dashboard', icon: 'dashboard', primary: true, onClick: () => ctx.navigate('/') },
      { label: 'Browse scripts', icon: 'library', onClick: () => ctx.navigate('/library') },
    ],
  });
  return { element, pageTitle: 'Page not found' };
}
