'use strict';

var util = require('util');
var recurse = require('openapi_optimise/common.js').recurse;
var circular = require('openapi_optimise/circular.js');
var jptr = require('jgexml/jpath.js');
var _mapValues = require('lodash/mapValues.js');
var _forOwn = require('lodash/forOwn.js');

const MAX_SCHEMA_DEPTH=100;

/* originally from https://github.com/for-GET/know-your-http-well/blob/master/json/status-codes.json */
/* "Unlicensed", public domain */
var statusCodes = require('./statusCodes.json');

// could change these to be regexes...
var xmlContentTypes = ['application/xml', 'text/xml', 'image/svg+xml', 'application/rss+xml', 'application/rdf+xml', 'application/atom+xml', 'application/mathml+xml', 'application/hal+xml'];
var jsonContentTypes = ['application/json', 'text/json', 'application/hal+json', 'application/ld+json', 'application/json-patch+json'];
var yamlContentTypes = ['application/x-yaml', 'text/x-yaml'];
var formContentTypes = ['multipart/form-data', 'application/x-www-form-urlencoded', 'application/octet-stream'];

function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function nop(obj) {
    return obj;
}

function dereference(obj, circles, api, cloneFunc, aggressive) {
    if (!cloneFunc) cloneFunc = nop;
    let circFunc = circular.hasCircles;
    if (aggressive) circFunc = circular.isCircular;
    while (obj && obj["$ref"] && !circular.isCircular(circles, obj.$ref)) {
        var oRef = obj.$ref;
        obj = cloneFunc(jptr.jptr(api, obj["$ref"]));
        obj["x-widdershins-oldRef"] = oRef;
    }
    var changes = 1;
    while (changes > 0) {
        changes = 0;

        _mapValues(obj, processItem)

        function processItem(value, key, obj) {
            if (value === undefined) { console.log(key + ' is ' + value); return; }
            if (value.__parent) return;
            if (typeof value === 'object') {
                value.__parent = obj;
                value.__pkey = key;
                _mapValues(value, processItem);
                delete value.__parent;
                delete value.__pkey;
            }

            if (key === '$ref') {
                changes++;
                replaceRef(obj);
            }
        }

        function replaceRef(obj) {
            if (obj.$ref && obj.__parent && obj.__pkey && !circular.isCircular(circles, obj.$ref)) {
                var initialObject = obj;
                var oRef = obj.$ref;
                var parent = obj.__parent;
                var pkey = obj.__pkey;

                obj = cloneFunc(jptr.jptr(api, obj["$ref"]));
                obj["x-widdershins-oldRef"] = oRef;

                if (initialObject.description) {
                    obj.description = initialObject.description;
                }

                if (initialObject.example) {
                    obj.example = initialObject.example;
                }


                parent[pkey] = obj;
            }
        }
        // recurse(obj, {}, function (obj, key, state) {

        //     if ((key === '$ref') && (typeof obj[key] === 'string') && (!circFunc(circles, obj[key]))) {
        //         state.parent[state.pkey] = cloneFunc(jptr.jptr(api, obj));
        //         state.parent[state.pkey]["x-widdershins-oldRef"] = obj;
        //         console.log('1');
        //         // state.parents[state.parents.length - 2][state.keys[state.keys.length - 2]] = cloneFunc(jptr.jptr(api, obj));
        //         // state.parents[state.parents.length - 2][state.keys[state.keys.length - 2]]["x-widdershins-oldRef"] = obj;
        //         delete state.parent["$ref"]; // just in case
        //         changes++;
        //     }
        // });
    }
    return obj;
}

function doContentType(types, targets) {
    for (var type in types) {
        for (var target of targets) {
            if (types[type] === target) return true;
        }
    }
    return false;
}

function languageCheck(language, language_tabs, mutate) {
    var lcLang = language.toLowerCase();
    if (lcLang === 'c#') lcLang = 'csharp';
    if (lcLang === 'c++') lcLang = 'cpp';
    for (var l in language_tabs) {
        var target = language_tabs[l];
        if (typeof target === 'object') {
            if (Object.keys(target)[0] === lcLang) {
                return lcLang;
            }
        }
        else {
            if (target === lcLang) return lcLang;
        }
    }
    if (mutate) {
        var newLang = {};
        newLang[lcLang] = language;
        language_tabs.push(newLang);
        return lcLang;
    }
    return false;
}

function gfmLink(text) {
    text = text.trim().toLowerCase();
    text = text.split("'").join('');
    text = text.split('"').join('');
    text = text.split('.').join('');
    text = text.split('`').join('');
    text = text.split(':').join('');
    text = text.split('/').join('');
    text = text.split('&lt;').join('');
    text = text.split('&gt;').join('');
    text = text.split('<').join('');
    text = text.split('>').join('');
    text = text.split(' ').join('-');
    return text;
}

function extract(o,parent,seen,depth,callback){
    JSON.stringify(o,function(k,v){
        if (v && v.properties) {
            for (let p in v.properties) {
                var already = seen.indexOf(v.properties[p])>=0;
                if (v.properties[p] && v.properties[p].type === 'array') already = true; // array processing
                if (!already) {
                    let required = false;
                    if (v.required && Array.isArray(v.required)) {
                        required = v.required.indexOf(p)>=0;
                    }
                    let oldRef = '';
                    if (v.properties[p]) {
                        oldRef = v.properties[p]["x-widdershins-oldRef"]||v.properties[p].$ref||'';
                    }
                    let newProp = {};
                    newProp[p] = v.properties[p];
                    callback(newProp,depth,required,oldRef);
                    seen.push(v.properties[p]);
                    if (depth<MAX_SCHEMA_DEPTH) {
                        extract(v.properties[p],p,seen,depth+1,callback);
                    }
                    else {
                        throw new Error('Max schema depth exceeded');
                    }
                 }
            }
        }
        if (v && v.type && v.type === 'array' && v.items) { // array processing
            var name = k||'anonymous';
            var dummy = {};
            dummy.properties = {};
            dummy.properties[name] = v.items;
            dummy.properties[name].description = v.description;
            dummy.properties[name]["x-widdershins-isArray"] = true;
            extract(dummy,k,seen,depth,callback);
        }
        return v;
    });
}

function schemaToArray(schema,depth,lines,singleLineDescription) {
    // console.log(depth, typeof depth);
    depth = depth || 0;
    if (!schema.properties && !schema.items) {
        let prop = {};
        prop.name = schema.title;
        if (!prop.name && schema.type && schema.type !== 'object') prop.name = 'simple';
        if (!prop.name && schema.additionalProperties) prop.name = 'additionalProperties';
        if (!prop.name && schema.patternProperties) prop.name = 'patternProperties';
        prop.description = schema.description||'No description';
        if (singleLineDescription) prop.description = prop.description.split('\n').join(' ');
        prop.type = schema.type||'Unknown';
        prop.required = false;
        prop.in = 'body';
        if (schema.format) prop.type = prop.type+'('+schema.format+')';
        prop.depth = 0;
        lines.unshift(prop);
    } else {
        if (schema.type !== 'object' || !schema.properties) {
            throw new Error('me not know non-object schema');
        }

        _forOwn(schema.properties, (prop, name) => {
            prop.__parent = schema;
            processItem(name, prop, schema, Boolean(schema.required && schema.required.indexOf(name) !== -1), depth);
            delete prop.__parent;
            // schemaToArray(prop, depth + 1, lines, trim);
        })
    }

    function processItem(name, item, schema, isRequired, depth) {
        if (item.type === 'array') {
            item.items["x-widdershins-isArray"] = true;
            return processItem(name, item.items, item, isRequired, depth); // skip array itself, process its item instead
        }
        let prefix = '»'.repeat(depth);
        let oldRef = item["x-widdershins-oldRef"] || item.$ref || null;
        let prop = {
            name: `${prefix} ${name}`.trim(),
            in: 'body',
            type: (item.type || 'Unknown') + (item.format ? `(${item.format})` : ''),
            required: isRequired,
            readOnly: item.readOnly === undefined ? schema.readOnly : item.readOnly,
            writeOnly: item.writeOnly === undefined ? schema.writeOnly : item.writeOnly,
            description:
                item.description && item.description !== 'undefined'
                    ? item.description
                    : (schema.description ? schema.description
                    : 'No description'), // the actual string 'undefined',
            depth: depth,
            schema: item.enum ? item.enum : item.schema,
        };

        // console.log(name, prop.name, isRequired, depth);

        if (singleLineDescription && typeof prop.description === 'string') {
            prop.description = prop.description.split('\n').join(' ')
        }

        if (((prop.type === 'object') || (prop.type === 'Unknown')) && oldRef) {
            oldRef = oldRef.split('/').pop();
            prop.type = '['+oldRef+'](#schema'+gfmLink(oldRef)+')';
        }

        if (item["x-widdershins-isArray"]) {
            prop.type = '['+prop.type+']';
        }

        lines.push(prop);
        if (item.type === 'object') {
            _forOwn(item.properties, (prop, name) => {
                if (prop.__parent) return;
                prop.__parent = schema;
                processItem(name, prop, item, Boolean(item.required && item.required.indexOf(name) !== -1), depth + 1);
                delete prop.__parent;
            })
        }
    }
}

function clean(obj) {
    if (!obj) return {};
    return JSON.parse(JSON.stringify(obj,function(k,v){
        if (k.startsWith('x-widdershins')) return;
        return v;
    }));
}

module.exports = {
    statusCodes : statusCodes,
    xmlContentTypes : xmlContentTypes,
    jsonContentTypes : jsonContentTypes,
    yamlContentTypes : yamlContentTypes,
    formContentTypes : formContentTypes,
    dereference : dereference,
    doContentType : doContentType,
    languageCheck : languageCheck,
    clone : clone,
    clean : clean,
    gfmLink : gfmLink,
    schemaToArray : schemaToArray
};
