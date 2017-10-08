module.exports = {
  language_tabs: [{ 'shell': 'Shell' }, { 'http': 'HTTP' }, { 'javascript': 'JavaScript' }, { 'javascript--nodejs': 'Node.JS' }, { 'ruby': 'Ruby' }, { 'python': 'Python' }, { 'java': 'Java' }],
  codeSamples: true,
  theme: 'darkula',
  search: true,
  sample: true,
  discovery: false,
  includes: [],
  templateCallback: function (templateName, stage, data) { return data; },
  schema: true
}
