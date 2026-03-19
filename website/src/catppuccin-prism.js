// Catppuccin Mocha — custom Prism theme for Docusaurus
// https://github.com/catppuccin/catppuccin

const theme = {
  plain: {
    color: '#cdd6f4',
    backgroundColor: '#1e1e2e',
  },
  styles: [
    {
      types: ['comment', 'prolog', 'doctype', 'cdata'],
      style: { color: '#6c7086', fontStyle: 'italic' },
    },
    {
      types: ['punctuation'],
      style: { color: '#cdd6f4' },
    },
    {
      // keywords: if, else, return, import, export, const, let, var, function, class...
      types: ['keyword', 'selector', 'important', 'atrule', 'rule', 'builtin'],
      style: { color: '#cba6f7' }, // mauve (purple)
    },
    {
      // strings and template literals
      types: ['string', 'char', 'attr-value', 'regex'],
      style: { color: '#94e2d5' }, // teal (cyan)
    },
    {
      // function names
      types: ['function', 'function-variable'],
      style: { color: '#89b4fa' }, // blue
    },
    {
      // class names, types, interfaces
      types: ['class-name', 'maybe-class-name', 'namespace', 'type-class-name'],
      style: { color: '#f9e2af' }, // yellow
    },
    {
      // numbers, booleans
      types: ['number', 'boolean', 'constant'],
      style: { color: '#fab387' }, // peach
    },
    {
      // variables and identifiers
      types: ['variable', 'property', 'symbol'],
      style: { color: '#cdd6f4' }, // text
    },
    {
      // operators, tags
      types: ['operator', 'entity', 'url'],
      style: { color: '#89dceb' }, // sky (lighter cyan)
    },
    {
      // HTML/JSX tag names
      types: ['tag'],
      style: { color: '#f38ba8' }, // red
    },
    {
      // HTML/JSX attribute names
      types: ['attr-name'],
      style: { color: '#fab387' }, // peach
    },
    {
      // deleted lines in diffs
      types: ['deleted'],
      style: { color: '#f38ba8' },
    },
    {
      // inserted lines in diffs
      types: ['inserted'],
      style: { color: '#a6e3a1' },
    },
    {
      types: ['bold'],
      style: { fontWeight: 'bold' },
    },
    {
      types: ['italic'],
      style: { fontStyle: 'italic' },
    },
  ],
};

export default theme;
