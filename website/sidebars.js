// @ts-check

/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  docs: [
    { type: 'doc', id: 'introduction',      label: 'Introduction' },
    { type: 'doc', id: 'deployment',        label: 'Deployment' },
    { type: 'doc', id: 'local-development', label: 'Local Development' },
    { type: 'doc', id: 'configuration',     label: 'Configuration' },
    {
      type: 'category',
      label: 'Scanners',
      link: { type: 'doc', id: 'scanners/index' },
      items: [
        { type: 'doc', id: 'scanners/semgrep',    label: 'Semgrep' },
        { type: 'doc', id: 'scanners/trufflehog', label: 'Trufflehog' },
        { type: 'doc', id: 'scanners/claude',     label: 'Claude' },
      ],
    },
    { type: 'doc', id: 'finding-suppression',   label: 'Finding Suppression' },
    { type: 'doc', id: 'exception-approvals',  label: 'Exception Approvals' },
    { type: 'doc', id: 'notifiers',             label: 'Notifiers' },
    { type: 'doc', id: 'pr-comments',           label: 'PR Comments' },
    { type: 'doc', id: 'metrics',               label: 'Metrics' },
    { type: 'doc', id: 'threat-model', label: 'Threat Model' },
    { type: 'doc', id: 'extending',             label: 'Extending Layne' },
    { type: 'doc', id: 'reference',             label: 'Reference' },
  ],
};

export default sidebars;
