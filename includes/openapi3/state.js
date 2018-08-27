var path = require('path');
var dot = require('dot');
dot.templateSettings.strip = false;
dot.templateSettings.varname = 'data';


function State(apiConfig, options, circles, initialData) {
  this.config = apiConfig;
  this.options = options;
  this.data = initialData || {};
  this.content = '';
  this.circles = circles || []; // what is this, indirect self references?

  this.templates = getTemplates(this);
}

State.prototype = {
  getConfig: function () {
    return this.config;
  },
  getOptions: function () {
    return this.options;
  },
  getTemplates: function () {
    return this.templates;
  },
  getCircles: function () {
    return this.circles;
  },
  getData: function () {
    return this.data;
  },
  setData: function (data) {
    this.data = data;
  },
  getContent: function () {
    return this.content;
  },
  appendContent: function (stringToAppend) {
    this.content += stringToAppend;
  },
  appendCode: function (language, code) {
    this.appendContent('```' + language + '\n');
    this.appendContent(code);
    this.appendContent('\n```\n');
  },
  appendTemplate: function (templateName) {
    // questionable decision to allow templateCallback returning a completely different object. why?

    if (typeof this.templates[templateName] === 'function') { // empty template support
      var options = this.getOptions();
      var data = this.getData();
      data = options.templateCallback(templateName, 'pre', data);
      handleCallbackResult(this, data);

      this.appendContent(this.templates[templateName](data) + '\n');

      data = options.templateCallback(templateName, 'post', data);
      handleCallbackResult(this, data);

      this.setData(data);

      function handleCallbackResult(state, data) {
        if (data.append) {
          state.appendContent(data.append);
          delete data.append;
        }
      }
    }
  }
}

var templates;
function getTemplates(state) {
  var options = state.getOptions();
  if (!templates || options.resetTemplates) {
    templates = dot.process({ path: path.join(__dirname, '..', '..', 'templates', 'openapi3') });
  }
  if (options.user_templates) {
    templates = Object.assign(templates, dot.process({ path: options.user_templates }));
  }

  // console.log(templates);

  return templates;
}

module.exports = State;
