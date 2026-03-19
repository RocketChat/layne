// @ts-check
import {themes as prismThemes} from 'prism-react-renderer';
import catppuccin from './src/catppuccin-prism.js';

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Layne',
  tagline: 'Self-hosted security scanning for GitHub pull requests',
  favicon: 'img/layne-logo.png',

  future: {
    v4: true,
  },

  url: 'http://localhost',
  baseUrl: '/',

  onBrokenLinks: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          routeBasePath: '/',
          sidebarPath: './sidebars.js',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      colorMode: {
        defaultMode: 'dark',
        respectPrefersColorScheme: true,
      },
      navbar: {
        title: 'Layne',
        logo: {
          alt: 'Layne',
          src: 'img/layne-logo.png',
        },
      },
      footer: {
        style: 'dark',
        copyright: `Built with Docusaurus.`,
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: catppuccin,
        additionalLanguages: ['bash', 'json', 'python', 'docker'],
      },
    }),
};

export default config;
