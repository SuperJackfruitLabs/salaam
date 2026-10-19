export function selectedSiteProjects(args, flags = []) {
  let selected;
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw Error('Duplicate site option: ' + arg);
    seen.add(arg);
    if (arg === '--site') {
      selected = args[++i];
      if (!['landing', 'docs'].includes(selected)) throw Error('Use --site landing or --site docs');
    } else if (!flags.includes(arg)) throw Error('Unknown site option: ' + arg);
  }
  return selected === 'landing'
    ? ['landing']
    : selected === 'docs'
      ? ['docs-site']
      : ['landing', 'docs-site'];
}
