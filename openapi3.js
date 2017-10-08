'use strict';

var up = require('url');
var util = require('util');
var _ = require('lodash');

var yaml = require('js-yaml');
var xml = require('jgexml/json2xml.js');
var jptr = require('jgexml/jpath.js');
var circular = require('openapi_optimise/circular.js');
var sampler = require('openapi-sampler');
var common = require('./common.js');
// var defaults = require('./includes/openapi3/defaults.js')
var State = require('./includes/openapi3/state.js');
var defaults = require('./includes/openapi3/defaults.js');

/**
* function to reformat openapi paths object into an iodocs-style resources object, tags-first
*/
function convertToToc(source, dest, callbackKey, callbackSetupOperationId) {
  var destPassed = !!dest;
  var isCallback = !!callbackKey;

  if (!dest) {
    dest = common.clone(source);
    dest.resources = {};
  }

  _.forIn(source.paths, function (path, pkey) {
    _.forIn(path, function (method, mkey) {
      if (['parameters', 'summary', 'description'].indexOf(mkey) === -1) {
        var ioMethod = {
          path: isCallback ? pkey.replace('{$request', '{$' + callbackSetupOperationId + '.request') : pkey,
          op: mkey
        }

        method.isCallback = isCallback;
        if (isCallback) {
          method.operationId = callbackKey;
          method.setupOperationId = callbackSetupOperationId;
        }
        var uniqueName = (method.operationId || mkey + '_' + pkey).split(/\/|\s/g).join('_');
        var tagName = _.get(method, ['tags', 0], 'Default');

        if (!dest.resources[tagName]) {
          var matchedTag = dest.tags && _.find(dest.tags, function (tag) {
            return tag.name === tagName;
          });

          dest.resources[tagName] = matchedTag ? _.clone(matchedTag) : {};
        }
        if (!dest.resources[tagName].methods) {
          dest.resources[tagName].methods = {};
        }
        dest.resources[tagName].methods[uniqueName] = ioMethod;

        if (!dest.resources[tagName].operations) {
          dest.resources[tagName].operations = {};
        }

        dest.resources[tagName].operations[uniqueName] = method;

        if (method.callbacks) {
          _.forIn(method.callbacks, function (callbackPathsConfig, key) {
            convertToToc({ paths: callbackPathsConfig }, dest, key, method.operationId)
          })
        }
      }
    })
  })

  delete dest.paths; // to keep size down
  delete dest.definitions; // ditto
  delete dest.components; // ditto
  return dest;
}

function processOperation(op, method, /* resource, */state) {
  var data = state.getData();
  var openapi = state.getConfig();
  var options = state.getOptions();
  var header = data.header;
  var subtitle = method.op.toUpperCase() + ' ' + method.path;
  var opName = op.operationId || subtitle;

  var url = op.isCallback ? method.path : data.servers[0].url + method.path;
  var produces = [];
  var consumes = [];

  state.appendContent('## ' + opName + '\n\n');

  var rbType = 'object';
  if (op.requestBody) {
    if (op.requestBody.$ref) {
      rbType = op.requestBody.$ref.replace('#/components/requestBodies/', '');
      rbType = '['+rbType+'](#'+common.gfmLink('schema+'+rbType)+')';
      op.requestBody = jptr.jptr(openapi, op.requestBody.$ref);
    }
    if (op.requestBody.content) {
      consumes = Object.keys(op.requestBody.content);
    }
  }
  _.forIn(op.responses, function (response) {
    if (response.$ref) {
      response = jptr.jptr(openapi, response.$ref);
    }
    if (response.content) {
      Array.prototype.push.apply(produces, Object.keys(response.content));
    }
  })

  data.method = method.op;
  data.methodUpper = method.op.toUpperCase();
  data.produces = produces;
  data.consumes = consumes;
  data.url = url;
  data.operation = method;
  data.operationId = op.operationId;
  data.tags = op.tags;
  data.security = op.security;
  data.queryString = '';
  data.requiredQueryString = '';
  data.queryParameters = [];
  data.requiredParameters = [];
  data.headerParameters = [];
  data.bodyParameter = null;

  var sharedParameters = _.get(openapi, ['paths', method.path, 'parameters'], []);
  var opParameters = _.get(openapi, ['paths', method.path, method.op, 'parameters'], []);

  // dereference shared/op parameters while separate before removing overridden shared parameters
  _.each([sharedParameters, opParameters], function (parameterSet) {
    _.each(parameterSet, function (parameter, key, arr) {
      if (parameter.$ref) {
        arr[key] = jptr.jptr(openapi, parameter.$ref);
      }
    })
  })

  // remove overridden shared (path) parameters
  if ((sharedParameters.length > 0) && (opParameters.length > 0)) {
    sharedParameters = [].concat(sharedParameters); // clone
    for (var sp of sharedParameters) {
      var match = opParameters.find(function (elem) {
        return ((elem.name == sp.name) && (elem.in == sp.in));
      });
      if (match) {
        sp["x-widdershins-delete"] = true;
      }
    }
    sharedParameters = sharedParameters.filter(function (e, i, a) {
      return !e["x-widdershins-delete"];
    });
  }

  // combine
  var parameters = sharedParameters.concat(opParameters);

  if (op.requestBody) {
    // fake a version 2-style body parameter
    var body = {};
    body.name = 'body';
    body.in = 'body';
    body.required = op.requestBody.required;
    body.description = op.requestBody.description ? op.requestBody.description : 'No description';
    body.schema = op.requestBody.content[Object.keys(op.requestBody.content)[0]].schema;
    if (body.schema && typeof body.schema.$ref === 'string') {
      rbType = body.schema.$ref.replace('#/components/schemas/','');
      rbType = '['+rbType+'](#'+common.gfmLink('schema'+rbType)+')';
      body.schema = common.dereference(body.schema, state.getCircles(), openapi, common.clone, options.aggressive);
    }
    body.type = rbType;
    parameters.push(body);
    if (options.schema && body.schema && body.schema.type && body.schema.type === 'object') {
      common.schemaToArray(body.schema,1,parameters,false);
    }
  }

  // console.log(produces);
  // process.exit();

  for (var p in parameters) {
    var param = parameters[p];
    param.required = (param.required ? param.required : false);
    param.safeType = (param.type || 'object');
    if (!param.depth) param.depth = 0;
    if (param.safeType == 'object') {
      if (param.schema && param.schema.type) {
        param.safeType = param.schema.type;
      }
      if (param.schema && param.schema["$ref"]) {
        param.safeType = param.schema["$ref"].split('/').pop();
        param.safeType = '['+param.safeType+'](#'+common.gfmLink('schema'+param.safeType)+')';
      }
    }
    if ((param.safeType == 'array') && param.schema && param.schema.items && param.schema.items.type) {
      param.safeType += '[' + param.schema.items.type + ']';
    }
    if ((param.safeType == 'array') && param.schema && param.schema.items && param.schema.items["$ref"]) {
      param.safeType += '[' + param.schema.items["$ref"].split('/').pop() + ']';
    }
    if (param.schema && param.schema.format) {
      param.safeType = param.safeType + '(' + param.schema.format + ')';
    }
    if (param.schema && param.schema["$ref"]) {
      param.exampleSchema = jptr.jptr(openapi, param.schema["$ref"]);
    }
    else {
      param.exampleSchema = param.schema || {};
    }
    param.exampleValues = {};
    param.exampleValues.json = '{}';
    param.exampleValues.object = {};
    try {
      var obj = sampler.sample(param.exampleSchema, { skipReadOnly: true });
      var t = obj;
      if (typeof t == 'string') t = "'" + t + "'";
      if (typeof t == 'object') t = JSON.stringify(t, null, 2);
      param.exampleValues.json = t;
      param.exampleValues.object = obj;
    }
    catch (ex) {
      console.error(ex);
      param.exampleValues.json = '...';
    }
    if ((param.in == 'body') && (!data.bodyParameter)) { // ignore expanded lines
      data.bodyParameter = param;
    }
    if (param.in == 'header') {
      data.headerParameters.push(param);
    }
    if (param.in == 'query') {
      let temp = param.exampleValues.object;
      if (Array.isArray(temp)) {
        temp = '...';
      }
      if (!param.allowReserved) {
        temp = encodeURIComponent(temp);
      }
      data.queryParameters.push(param);
      data.queryString += (data.queryString ? '&' : '?') + param.name + '=' + temp;
      if (param.required) {
        data.requiredQueryString += (data.requiredQueryString ?
          '&' : '?') + param.name + '=' + temp;
        data.requiredParameters.push(param);
      }
    }
  }
  data.parameters = parameters;

  data.allHeaders = common.clone(data.headerParameters);
  if (data.consumes.length) {
    var contentType = {};
    contentType.name = 'Content-Type';
    contentType.type = 'string';
    contentType.in = 'header';
    contentType.exampleValues = {};
    contentType.exampleValues.json = "'" + data.consumes[0] + "'";
    contentType.exampleValues.object = data.consumes[0];
    data.allHeaders.push(contentType);
  }
  if (data.produces.length) {
    var accept = {};
    accept.name = 'Accept';
    accept.type = 'string';
    accept.in = 'header';
    accept.exampleValues = {};
    accept.exampleValues.json = "'" + data.produces[0] + "'";
    accept.exampleValues.object = data.produces[0];
    data.allHeaders.push(accept);
  }

  var codeSamples = (options.codeSamples || op["x-code-samples"]);
  if (codeSamples) {
    state.appendTemplate('heading_code_samples');
    // applyTemplate('heading_code_samples', state);

    if (op["x-code-samples"]) {
      for (var s in op["x-code-samples"]) {
        var sample = op["x-code-samples"][s];
        var lang = common.languageCheck(sample.lang, header.language_tabs, true);
        state.appendCode(lang, sample.source);
      }
    }
    else {
      for (var l in header.language_tabs) {
        var target = header.language_tabs[l];
        if (typeof target === 'object') {
          target = Object.keys(target)[0];
        }
        var lcLang = common.languageCheck(target, header.language_tabs, false);
        if (lcLang) {
          var templateName = 'code_'+lcLang.substring(lcLang.lastIndexOf('-') + 1);
          var templateFunc = state.getTemplates()[templateName];
          if (templateFunc) {
            state.appendContent('```' + lcLang + '\n');
            state.appendTemplate(templateName);
            // applyTemplate(templateName, state);
            state.appendContent('```\n\n');
          }
        }
      }
    }
  }

  // TODO template?
  if (subtitle != opName) state.appendContent('`' + subtitle + '`\n\n');
  if (op.summary) state.appendContent('*' + op.summary + '*\n\n');
  if (op.description) state.appendContent(op.description + '\n\n');

  data.enums = [];

  if (parameters.length > 0) {
    var longDescs = false;
    for (var p in parameters) {
      param = parameters[p];
      param.shortDesc = (typeof param.description === 'string') ? param.description.split('\n')[0] : 'No description';
      if ((typeof param.description === 'string') && (param.description.trim().split('\n').length > 1)) longDescs = true;
      param.originalType = param.type;
      param.type = param.safeType;

      if (param.schema && param.schema.enum) {
        for (var e in param.schema.enum) {
          var nvp = {};
          nvp.name = param.name;
          nvp.value = param.schema.enum[e];
          data.enums.push(nvp);
        }
      }
      if (param.schema && param.schema.items && param.schema.items.enum) {
        for (var e in param.schema.items.enum) {
          var nvp = {};
          nvp.name = param.name;
          nvp.value = param.schema.items.enum[e];
          data.enums.push(nvp);
        }
      }
    }

    var paramHeader = false;
    for (var p in parameters) {
      param = parameters[p];
      if ((param.in === 'body') && (param.depth == 0)) {
        var xmlWrap = '';
        var obj = common.dereference(param.schema, state.getCircles(), openapi, common.clone, options.aggressive);
        if (obj && !paramHeader) {
          state.appendTemplate('heading_body_parameter');
          // applyTemplate('heading_body_parameter', state);
          paramHeader = true;
        }
        if (obj && obj.xml && obj.xml.name) {
          xmlWrap = obj.xml.name;
        }
        if (obj && options.sample) {
          try {
            obj = sampler.sample(obj, { skipReadOnly: true });
          }
          catch (ex) {
            console.error(ex);
          }
        }
        else {
          obj = common.clean(obj);
        }
        if (obj && obj.properties) obj = obj.properties;
        if (obj) {
          if (common.doContentType(consumes, common.jsonContentTypes)) {
            state.appendCode('json', JSON.stringify(obj, null, 2));
          }
          if (common.doContentType(consumes, common.yamlContentTypes) || common.doContentType(consumes, common.formContentTypes)) {
            state.appendCode('yaml', yaml.safeDump(obj));
          }
          if (common.doContentType(consumes, common.xmlContentTypes) && (typeof obj === 'object')) {
            if (xmlWrap) {
              var newObj = {};
              newObj[xmlWrap] = obj;
              obj = newObj;
            }
            state.appendCode('xml', xml.getXml(obj, '@', '', true, '  ', false));
          }
        }
      }
    }

    data.parameters = parameters; // redundant?
    state.appendTemplate('parameters');
    // applyTemplate('parameters', state);

    if (longDescs) {
      for (var p in parameters) {
        var param = parameters[p];
        var desc = param.description ? param.description : '';
        var descs = [];
        if (typeof desc === 'string') {
          descs = desc.trim().split('\n');
        }
        if (descs.length > 1) {
          // TODO template
          state.appendContent('##### ' + param.name + '\n');
          state.appendContent(desc + '\n');
        }
      }
    }
  }

  var responseSchemas = false;
  var responseHeaders = false;
  var inlineSchemas = false;
  data.responses = [];
  for (var resp in op.responses) {
    let response = op.responses[resp];
    if (response.schema || response.content) responseSchemas = true;
    if (response.headers) responseHeaders = true;
  }

  for (var resp in op.responses) {
    let response = op.responses[resp];

    response.status = resp;
    response.meaning = (resp == 'default' ? 'Default' : 'Unknown');
    var url = '';
    for (var s in common.statusCodes) {
      if (common.statusCodes[s].code == resp) {
        response.meaning = common.statusCodes[s].phrase;
        url = common.statusCodes[s].spec_href;
        break;
      }
    }
    if (url) response.meaning = '[' + response.meaning + '](' + url + ')';
    if (!response.description) response.description = 'No description';
    response.description = response.description.trim();

    response.schema = 'None';
    if (response.content) {
      for (let c in response.content) {
        let mediatype = response.content[c];
        if (mediatype.schema) {
          response.schema = 'Inline';
          if (mediatype.schema.$ref) {
            let ref = mediatype.schema.$ref.split('/').pop();
            response.schema = '['+ref+'](#schema'+common.gfmLink(ref)+')';
          }
          else if ((Object.keys(mediatype.schema).length == 1) && (mediatype.schema.type)) {
            response.schema = mediatype.schema.type;
          }
          else if ((Object.keys(mediatype.schema).length == 2) && (mediatype.schema.type) && (mediatype.schema.format)) {
            response.schema = mediatype.schema.type+'('+mediatype.schema.format+')';
          }
          else {
            inlineSchemas = true;
          }
        }
      }
    }
    data.responses.push(response);
  }

  if (responseSchemas) {
    state.appendTemplate('heading_example_responses');
    // applyTemplate('heading_example_responses', state);
    for (var resp in op.responses) {
      var response = op.responses[resp];
      for (var ct in response.content) {
        var contentType = response.content[ct];
        var cta = [ct];
        if (contentType.schema) {
          var xmlWrap = '';
          var obj = {};
          try {
            obj = common.dereference(contentType.schema, state.getCircles(), openapi, common.clone, options.aggressive);
          }
          catch (ex) {
            console.error(ex.message);
          }
          if (obj && obj.xml && obj.xml.name) {
            xmlWrap = obj.xml.name;
          }
          if (Object.keys(obj).length > 0) {
            if (options.sample) {
              try {
                obj = sampler.sample(obj); // skipReadOnly: false
              }
              catch (ex) {
                console.error(ex);
              }
            }
            else {
              obj = common.clean(obj);
            }
            // TODO support embedded/reffed examples
            if (common.doContentType(cta, common.jsonContentTypes)) {
              state.appendCode('json', JSON.stringify(obj, null, 2));
            }
            if (common.doContentType(cta, common.yamlContentTypes)) {
              state.appendCode('yaml', yaml.safeDump(obj));
            }
            if (typeof obj === 'object' && common.doContentType(cta, common.xmlContentTypes)) {
              if (xmlWrap) {
                var newObj = {};
                newObj[xmlWrap] = obj;
                obj = newObj;
              }

              state.appendCode('xml', xml.getXml(obj, '@', '', true, '  ', false));
            }
          }
        }
      }
    }
  }

  state.appendTemplate('responses');
  // applyTemplate('responses', state);

  if (inlineSchemas && options.schema) {
    for (var resp in op.responses) {
      var response = op.responses[resp];
      for (var ct in response.content) {
        var contentType = response.content[ct];
        if (contentType.schema && !contentType.schema.$ref) {
          data.schemaProperties = [];
          data.responseStatus = resp;
          data.response = response;
          common.schemaToArray(contentType.schema,0,data.schemaProperties,true);

          data.enums = [];
          for (var prop in data.schemaProperties) {
            if (prop.schema) {
              for (var e in prop.schema.enum) {
                var nvp = {};
                nvp.name = param.name;
                nvp.value = param.schema.enum[e];
                data.enums.push(nvp);
              }
            }
          }

          state.appendTemplate('response_schema');
          // applyTemplate('response_schema', state);
        }
        break; // only show one content-type for now
      }
    }
  }

  if (responseHeaders) {
    data.response_headers = [];
    for (var resp in op.responses) {
      var response = op.responses[resp];
      for (var h in response.headers) {
        var hdr = response.headers[h];
        hdr.status = resp;
        hdr.header = h;
        if (!hdr.format) hdr.format = '';
        if (!hdr.description) hdr.description = '';
        if (!hdr.type && hdr.schema && hdr.schema.type) {
          hdr.type = hdr.schema.type;
          hdr.format = hdr.schema.format || '';
        }

        data.response_headers.push(hdr);
      }
    }

    state.appendTemplate('response_headers');
    // applyTemplate('response_headers', state);
  }

  var security = op.security || openapi.security || [];
  if (security.length === 0) {
    state.appendTemplate('authentication_none');
    // applyTemplate('authentication_none', state);
  }
  else {
    data.securityDefinitions = [];
    var list = '';
    for (var s in security) {
      var link;
      link = '#/components/securitySchemes/' + Object.keys(security[s])[0];
      var secDef = jptr.jptr(openapi, link);
      data.securityDefinitions.push(secDef);
      list += (list ? ', ' : '') + (secDef ? secDef.type : 'None');
      var scopes = security[s][Object.keys(security[s])[0]];
      if (Array.isArray(scopes) && (scopes.length > 0)) {
        list += ' ( Scopes: ';
        for (var scope in scopes) {
          list += scopes[scope] + ' ';
        }
        list += ')';
      }
    }
    data.authenticationStr = list;
    state.appendTemplate('authentication');
    // applyTemplate('authentication', state);
  }

  state.appendContent('\n');
}

// TODO: callbacks, include an enclosing div with a specific class
// TODO: links

function convert(openapi, options, callback) {
  options = Object.assign({}, defaults, options);
  if (!options.codeSamples) options.language_tabs = [];

  var state = new State(openapi, options, circular.getCircularRefs(openapi, options));
  state.setData(getDataMockup(state));
  // var templates = getTemplates(state);
  state.appendTemplate('heading_main');

  var data = state.getData();
  // applyTemplate('heading_main', state);

  var securityContainer = (openapi.components && openapi.components.securitySchemes);
  if (securityContainer) {
    data.securityDefinitions = getSecurityDefinitions(securityContainer);
    state.appendTemplate('security');
    // applyTemplate('security', state);
  }

  var apiInfo = convertToToc(openapi);
  // console.log(apiInfo);
  // process.exit();

  _.forIn(apiInfo.resources, function (resource, key) {
    state.appendContent('# ' + key + '\n\n');
    if (resource.description) state.appendContent(resource.description + '\n\n');
    var extLink = getExternalDocsLink(resource.externalDocs);
    if (extLink) {
      state.appendContent(extLink);
    }

    _.forIn(resource.methods, function (method, mkey) {
      // state.getData().subtitle
      if (!method.op.startsWith('x-')) {
        // console.log(_.get(resource, 'operations', mkey), _.get(state.getConfig(), 'paths', method.path, method.op));
        // console.log(_.get(state.getConfig(), ['paths', method.path, method.op]));
        // console.log(_.get(resource, ['operations', mkey]));
        // process.exit();
        processOperation(
          _.get(resource, ['operations', mkey]),
          method,
          // resource,
          state
        );
      }
    })
  })

  if (options.schema && openapi.components && openapi.components.schemas && Object.keys(openapi.components.schemas).length>0) {
    state.appendTemplate('schema_header');
    // applyTemplate('schema_header', state);

    _.forIn(openapi.components.schemas, function (schema, key) {
      state.appendContent('## ' + key + '\n\n');
      state.appendContent('<a name="schema' + key.toLowerCase() + '"></a>\n\n');
      var schema = common.dereference(schema, state.getCircles(), openapi, common.clone, options.aggressive);
      var data = state.getData();

      // ugh that's ugly
      var obj;
      if (options.sample) {
        try {
          obj = sampler.sample(schema); // skipReadOnly: false
          data.schema = obj; // temporary substitution for a sample template, that's really ugly
          state.appendTemplate('schema_sample');
          // applyTemplate('schema_sample', state);
        }
        catch (ex) {
          console.error(ex);
        }
      }
      // is the "else" actually not needed? it should be, right?
      // else {
      //   obj = common.clean(schema);
      // }

      data.schema = schema;
      data.schemaProperties = [];
      common.schemaToArray(schema, 0, data.schemaProperties, true);

      data.enums = _.map(function (property) {
        var enumValues = _.get(property, ['schema', 'enum']);
        return enumValues && enumValues.map(function (enumValue) {
          return { name: property.name, value: enumValue };
        })
      }).filter(function (value) {
        return value; // filter out falsey values (non-enum)
      });

      state.appendTemplate('schema_properties');
      // applyTemplate('schema_properties', state);
    })
  }

  state.appendTemplate('footer');
  // applyTemplate('footer', state);
  if (options.discovery) {
    state.appendTemplate('discovery');
    // applyTemplate('discovery', state);
  }

  // console.log(data);
  var headerStr = '---\n' + yaml.safeDump(data.header) + '---\n';
  // apparently you can insert jekyll front-matter in here for github
  // see https://github.com/lord/slate/issues/702
  var result = (headerStr + '\n' + state.getContent().split('\n\n\n').join('\n\n'));
  if (callback) callback(null, result);
  return result;
}

module.exports = {
  convert: convert
};

function getServers(state) {
  var servers;
  var openapi = state.getConfig();
  var options = state.getOptions();
  if (openapi.servers && openapi.servers.length) {
      servers = openapi.servers;
  }
  else if (options.loadedFrom) {
      servers = [{url:options.loadedFrom}];
  }
  else {
      servers = [{url:'//'}];
  }

  return servers;
}

// function applyTemplate(templateName, state) {
//   // questionable decision to allow templateCallback returning a completely different object. why?
//   var data = options.templateCallback(templateName, 'pre', state.getData());
//   handleCallbackResult(state, data);
//
//   state.appendContent(templates[templateName](data) + '\n');
//
//   data = options.templateCallback(templateName, 'post', data);
//   handleCallbackResult(state, data);
//
//   state.setData(data);
//
//   function handleCallbackResult(state, data) {
//     if (data.append) {
//       state.appendContent(data.append);
//       delete data.append;
//     }
//   }
// }

function getHeaderConfig(state) {
  var options = state.getOptions();
  var openapi = state.getConfig();
  // console.log(options);
  // process.exit();
  var header = {
    title: openapi.info.title + ' ' + ((openapi.info.version && openapi.info.version.toLowerCase().startsWith('v')) ? openapi.info.version : 'v' + (openapi.info.version||'?')),
    toc_footers: [],
    includes: options.includes,
    search: options.search,
    highlight_theme: options.theme,
    language_tabs: options.language_tabs
  };

  var externalLink = getExternalDocsLink(openapi.externalDocs);
  if (externalLink) {
    header.toc_footers.push(externalLink);
  }

  return header;
}

function getDataMockup(state) {
  var openapi = state.getConfig();
  var data = {};
  data.openapi = openapi; // for backwards compatibility
  data.header = getHeaderConfig(state)
  data.servers = getServers(state);

  var urlParsed = up.parse(data.servers[0].url);

  data.host = urlParsed.host;
  data.protocol = urlParsed.protocol;
  if (data.protocol) data.protocol = data.protocol.replace(':','');

  data.contactName = _.get(state.getConfig(), ['info', 'contact', 'name'], 'Support');
  return data;
}

function getSecurityDefinitions(securityConfig) {
  return _.map(securityConfig, mapDefinition)

  function mapDefinition(definition, key) {
    if (definition.type == 'oauth2') {
      definition.flowArray = _.map(definition.flows, mapFlow)
    }
    definition.ref = key;
    if (!definition.description) definition.description = '';
    return definition;
  }

  function mapFlow(flow, key) {
    flow.flowName = key;
    flow.scopeArray = _.map(flow.scopes, mapScope);
  }

  function mapScope(scope, key) {
    return {
      name: key,
      description: scope
    }
  }
}

function getExternalDocsLink(docs) {
  if (docs && docs.url) {
    return '<a href="' + docs.url + '">' + (docs.description || 'External Docs') + '</a>';
  }
}
