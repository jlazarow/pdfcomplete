/*\
title: $:/plugins/jlazarow/pdfcomplete/completion.js
type: application/javascript
module-type: library

Try to make self-contained completion module.

To use this 'module', you need a `widget` with a kind of `editarea` node.
I do not know the exacte prerequisites of this editarea node for the module to
work, but mostly one should be able to attach the following `eventHandler` to
it:
 - input
 - keydown
 - keypress
 - keyup
The `widget` is needed because I use:
 - widget.document
 - widget.wiki.filterTiddlers(...)

From the Widget, once you have a proper editarea, you just have to call
 - var completion = new Completion( theWidget, theEditAreaNode, configObject);
where `configObject` is expected to have the following fields. if a field is missing, a default value will be given.
One can have many `elements' in the template array.

{
  "configuration": {
      "caseSensitive" : false,
      "maxMatch" : 8,
      "minPatLength" : 2,
      "triggerKeyCombination" : "^ "
  },
  "template": [{
      "pattern": "[[",
      "filter": "[all[tiddlers]!is[system]]",
      "start": "[[",
      "end": "]]"
      }
  ]
}

TODO : CHECK if needed
\*/

(function(){

/*jslint node: true, browser: true */
/*global $tw: false */
"use strict";

// To compute pixel coordinates of cursor
var getCaretCoordinates = require("$:/plugins/jlazarow/pdfcomplete/cursor-position.js");
var pdfparser = require("$:/plugins/tiddlywiki/pdfjs/pdf-parser.js");
var pdf = require("$:/plugins/tiddlywiki/pdfjs/pdf.js");
var pdfworker = require("$:/plugins/tiddlywiki/pdfjs/pdf.worker.js");

var PDF_WORKER_PREFIX = "files";
var REBUILD = true;
    
pdf.GlobalWorkerOptions.workerSrc = PDF_WORKER_PREFIX + "/" + "pdf.worker.js";

/** 
 * Struct for generic Completion Templates.
 * <ul>
 * <li>pat : pattern searched for.</li>
 * <li>filter : filter operation used to find the list of completion options</li>
 * <li>mask: replaced by "" when presenting completion options</li>
 * </ul>
 */
var Template = function(pat, filter, mask, field, start, end) {
    this.pat = pat;
    this.filter = filter;
    this.mask = "^" + regExpEscape(mask);
    this.field = field;
    this.start = start;
    this.end = end;
    this.pos = 0;
};
/**
 * Struct for storing completion options, as we need to memorise 
 * the titles of the tiddlers when masked and when body must be displayed.
 */
var OptCompletion = function(title, str, obj) {
    this.title = title;
    this.str = str;
    this.obj = obj || null;
};

var keyMatchGenerator = function(combination) {
	let singleMatchGenerator = function(character) {
		if (character === '^') {
			return event => event.ctrlKey;
		}
		else if (character === '+') {
			return event => event.shiftKey;
		}
		else if (character === '!') {
			return event => event.altKey;
		}
		else {
			return event => (event.keyCode || event.which) === character.charCodeAt(0);
		}
	};

	let matchers = [];
	for (let i = 0; i < combination.length; i++) {
		matchers.push(singleMatchGenerator(combination[i]));
	}

	return event => {
		for (let i = 0; i < matchers.length; i++) {
			if (!matchers[i](event)) {
				return false;
			}
		}
		return true;
	};
};

function CompletedItem(title, obj, indent) {
    this.title = title;
    this.obj = obj;
    this.indent = indent || 0;
}

function CompletionSource(wiki, tiddler, caseSensitive, maximumMatches) {
    this.wiki = wiki;
    this.tiddler = tiddler;
    this.caseSensitive = caseSensitive;
    this.maximumMatches = maximumMatches;
    this.maskPrefix = null;
    this.pdf = null;    
    this.paper = null;    
}

// should return "CompletedItem[]"
CompletionSource.prototype.complete = function(partial) {
    return [];
}

CompletionSource.prototype.rank = function(completions, partial, limit) {
    limit = limit || this.maximumMatches;
        
    var regexFlag = this.caseSensitive ? "" : "i";
    var regexPattern = RegExp(regExpEscape(partial), regexFlag);
    var regexPatternStart = RegExp("^" + regExpEscape(partial), regexFlag);
    var regexMask = RegExp(this.maskPrefix || "", "");

    var numberMatches = 0;

    var bestMatches = [];
    var otherMatches = []

    console.log(completions);
    for (var completionIndex = 0; completionIndex < completions.length; completionIndex++) {
        var completion = completions[completionIndex];
	var maskedTitle = completion.title.replace(regexMask, "");

        // good matches _begin_ with the pattern. I think this should just
        // be re-factored to take the "found index" and compute a score from
        // that. leaving like this for now.
 	if (regexPatternStart.test(maskedTitle)) {
	    if (numberMatches >= limit) {
                // I guess reserve the last one for "more".
		bestMatches.push(new OptCompletion("", "...", null));
		return bestMatches;
	    } else {
		bestMatches.push(new OptCompletion(completion.title, maskedTitle, completion.obj));
		numberMatches += 1;
	    }
	}
	else if (regexPattern.test(maskedTitle)) {
            // then if pattern is found WITHIN the maskedChoice
	    // added AFTER the choices that starts with pattern
	    if (numberMatches >= limit) {
                // finish things off. this should really just be a "break"
		bestMatches.push(new OptCompletion("", "<hr>", null)); //separator
		bestMatches = bestMatches.concat(otherMatches);
		bestMatches.push(new OptCompletion("", "...", null));

                return bestMatches;
	    } else {
		otherMatches.push(new OptCompletion(completion.title, maskedTitle, completion.obj));
		numberMatches += 1;
	    }
	}
    }

    // Here, must add the otherMatches
    bestMatches.push(new OptCompletion("", "<hr>", null)) ; //separator
    bestMatches = bestMatches.concat(otherMatches);

    // would rather "return" this. my guess is the previous code might
    // be hitting weirdness if threads exist.
    return bestMatches;
}

CompletionSource.prototype.completed = function(match) {
    return match.str;        
}

CompletionSource.prototype.associatedPDF = function(pdf) {
    this.pdf = pdf;
}

CompletionSource.prototype.associatedPaper = function(paper) {
    this.paper = paper;
}
    
// preserving the original tiddler based implementation.
// I think this needs a "term"?    
function FilteringCompletionSource(wiki, tiddler, caseSensitive, maximumMatches, template) {
    CompletionSource.call(this, wiki, tiddler, caseSensitive, maximumMatches);

    this.template = template || null;

    if (this.template != null && this.template.mask != null) {
        this.maskPrefix = this.template.mask;
        console.log("mask prefix: " + this.maskPrefix);
    }
    else {
        console.log("no mask prefix");
    }
}

FilteringCompletionSource.prototype = Object.create(CompletionSource.prototype);
FilteringCompletionSource.prototype.constructor = FilteringCompletionSource;
    
FilteringCompletionSource.prototype.complete = function(partial, limit) {
    console.log("FilteringCompletionSource.complete()");

    var matchingNames = null;
    if (this.template != null) {
        matchingNames = this.wiki.filterTiddlers(this.template.filter);
    }
    else {
        matchingNames = this.wiki.filterTiddlers("[all[tiddlers]]");
    }

    // speed implications here.
    var items = [];
    for (var nameIndex = 0; nameIndex < matchingNames.length; nameIndex++) {
        items.push(new CompletedItem(matchingNames[nameIndex], null));
    }
    
    return this.rank(items, partial, limit);
}

FilteringCompletionSource.prototype.completed = function(match) {
    var stringValue = match.str;
    
    if (this.template != null && this.template.field === "body") {
	stringValue = $tw.wiki.getTiddlerText(match.title);
    }

    // encapsulate in [[]] link.
    return "[](#" + stringValue + ")";
}

function PDFOutlineItem(title, destination, level, items) {
    this.title = title;
    this.destination = destination;
    this.level = level;
    this.items = items;
}

PDFOutlineItem.parse = function(item, level) {
    var childItems = [];

    for (var itemIndex = 0; itemIndex < item.items.length; itemIndex++) {
        var childItem = PDFOutlineItem.parse(item.items[itemIndex], level + 1);
        childItems.push(childItem);
    }

    var title = item.title;
    var destination = item.dest;

    return new PDFOutlineItem(title, destination, level, childItems);
}

PDFOutlineItem.prototype.getFlattened = function() {
    var flattened = [ this ];

    for (var itemIndex = 0; itemIndex < this.items.length; itemIndex++) {
        var item = this.items[itemIndex];

        flattened = flattened.concat(item.getFlattened());
    }

    return flattened;
}
    
function PDFOutline(rootItems) {
    // recursively read the top level items.
    this.items = [];

    for (var rootItemIndex = 0; rootItemIndex < rootItems.length; rootItemIndex++) {
        var item = PDFOutlineItem.parse(rootItems[rootItemIndex], 0);
        this.items.push(item);
    }

    console.log("outline:");
    console.log(this.items);
}

PDFOutline.prototype.getFlattened = function() {
    var flattened = [];

    for (var itemIndex = 0; itemIndex < this.items.length; itemIndex++) {
        var item = this.items[itemIndex];
        
        flattened = flattened.concat(item.getFlattened());
    }

    return flattened;
}    

function ServedPDF(name) {
    this.name = name;
    this.document = null;
    this.outline = null;
    this.title = null;   
}

ServedPDF.prototype.read = function() {   
    console.log("attempting to parse PDF named " + this.name);
    return pdf.getDocument({
        url: PDF_WORKER_PREFIX + "/" + this.name,
        nativeImageDecoderSupport: pdf.NativeImageDecoding.DISPLAY
    }).then(function(document) {
        console.log("woo, got document");
        console.log(document);

        this.document = document;
        return this.document.getOutline();
    }.bind(this)).then(function(outline) {
        console.log("woo, got outline");
        console.log(outline);

        if (outline != null) {
            this.outline = new PDFOutline(outline);
            console.log(this.outline);
            console.log(this.outline.getFlattened());
        }

        return this.document.getMetadata();
    }.bind(this)).then(function(metadata) {
        console.log(metadata);
        this.title = metadata.info["Title"];        
        console.log("title is " + this.title);

        return this.title;
    }.bind(this));
}

// we should have something that also tries to partially populate it from
// TiddlyWiki itself.    
function PDFNameCompletionSource(wiki, tiddler, caseSensitive, maximumMatches, template) {
    CompletionSource.call(this, wiki, tiddler, caseSensitive, maximumMatches);

    this.template = template || null;

    if (this.template != null && this.template.mask != null) {
        this.maskPrefix = this.template.mask;
        console.log("mask prefix: " + this.maskPrefix);
    }
    else {
        console.log("no mask prefix");
    }

    this.references = [];
}

PDFNameCompletionSource.prototype = Object.create(CompletionSource.prototype);
PDFNameCompletionSource.prototype.constructor = PDFNameCompletionSource;

PDFNameCompletionSource.prototype.associatePaper = function(paper) {
    this.paper = paper;
    //this.indexReferences(paper);
}        
    
PDFNameCompletionSource.prototype.indexReferences = function(paper) {
    var references = paper.references;
    if (references.length == 0) {
        return;
    }

    for (var referenceIndex = 0; referenceIndex < references.length; refereneIndex++) {
        var reference = references[referenceIndex];
        var referenceParts = reference.id.split(":");
        var referenceType = referenceParts[0];
        var referenceValue = referenceParts.slice(1).join(":");
        console.log("ref of type " + referenceType + " value " + referenceValue);
        var matchingNames = this.wiki.filterTiddlers("[!has[draft.of]field:" + referenceType + "[" + referenceValue + "]]");
        if (matchingNames.length > 0) {
            this.references.push(matchingNames[0]);
        }
    }

    console.log("resolved references");
    console.log(this.references);
}
        
PDFNameCompletionSource.prototype.complete = function(partial, limit) {
    console.log("PDFNameCompletionSource.complete()");
    console.log(partial);

    // this will be a little more complicated. we're interested in:
    // "named destinations" (e.g. outline).
    // "images/graphs".
    // for now just complete against the default PDF with the outline.

    var items = [];
    if (this.outline != null) {
        var flattened = this.pdf.outline.getFlattened();

        for (var outlineIndex = 0; outlineIndex < flattened.length; outlineIndex++) {
            var outlineItem = flattened[outlineIndex];

            items.push(new CompletedItem(outlineItem.title, outlineItem, outlineItem.level));                
        }            
    }

    // // each each referenced paper..
    // console.log("completing " + this.references.length + " references");
    // for (var referenceIndex = 0; referenceIndex < this.references.length; referenceIndex++) {
    //     var referenceName = this.references[referenceIndex];

    //     items.push(new CompletedItem(referenceName, null, 0));
    // }

    // if (items.length == 0) {
    //     return [];
    // }

    // return this.rank(items, partial, limit);
}

PDFNameCompletionSource.prototype.completed = function(match) {
    var matchItem = match.obj;

    if (match.obj instanceof PDFOutlineItem) {
        // point this to the named destination: pdfname
        return "[](" + this.pdf.name + "#" + match.obj.destination + ")";
    }

    return "[](#" + match.str + ")";
}

function PDFGraphicSource(wiki, tiddler, caseSensitive, maximumMatches, template) {
    CompletionSource.call(this, wiki, tiddler, caseSensitive, maximumMatches);

    this.template = template || null;

    if (this.template != null && this.template.mask != null) {
        this.maskPrefix = this.template.mask;
        console.log("mask prefix: " + this.maskPrefix);
    }
    else {
        console.log("no mask prefix");
    }

    // start the process of parsing the default PDF (if there is one).
    this.pdfName = null;
    if (PDF_FIELD_NAME in tiddler.fields) {
        this.pdfName = tiddler.fields[PDF_FIELD_NAME]
    }

    this.resourcesByPage = {};
    this.getPDFResources();
}

PDFGraphicSource.prototype = Object.create(CompletionSource.prototype);
PDFGraphicSource.prototype.constructor = PDFGraphicSource;

PDFGraphicSource.prototype.getPDFResources = function() {
    if (this.pdfName == null) {
        return;
    }

    console.log("retrieving all resources of pdf: " + this.pdfName);

    // for (var pageIndex = 0; pageIndex < 1; pageIndex++) {
    //     console.log("loading resources for page " + pageIndex);

    //     $tw.utils.httpRequest({
    //         url: "/pdf_resources/" + this.pdfName + "/page/" + pageIndex,
    //         type: "GET",
    //         callback: function(error, data) {
    //             if (error)
    //             {
    //                 console.log("Failed to retrieve PDF resources for page " + pageIndex + ": " + error.toString());
    //             }
    //             else
    //             {
    //                 console.log("Successfully retrieved PDF resources for page " + pageIndex);
    //                 console.log(data);
    //                 this.resourcesByPage[pageIndex] = data;
    //             }
    //         }.bind(this)
    //     });
    // }

    console.log(this.resourcesByPage);
}
    
PDFGraphicSource.prototype.complete = function(partial, limit) {
    console.log("PDFGraphicSource.complete()");
    console.log(partial);
}

PDFGraphicSource.prototype.completed = function(match) {
}    

/**
 * Widget is needed in creating popupNode.
 * - widget.document
 * - widget.wiki.filterTiddlers(...)
 * - sibling : where to create the popup in the DOM.
 */
var STATE_VOID = "VOID";
var STATE_PATTERN = "PATTERN";
var STATE_SELECT = "SELECT";

var DEFAULT_MAX_MATCH = 5;    
var DEFAULT_MIN_PATTERN_LENGTH = 0; // I guess set this to zero for now.
var DEFAULT_CASE_SENSITIVE = false;
var DEFAULT_TRIGGER_KEY_COMBO = "^ ";

// from what I understand, a widget is tied to a specific tiddler, so we should
// have no problem storing specific data here.    
var Completion = function(editWidget, areaNode, param, sibling, offTop, offLeft) {
    console.log("Completion.creation(()");
    console.log(editWidget);

    // About underlying Widget
    this._widget = editWidget;
    this._wiki = this._widget.wiki;
    this._tiddler = this._wiki.getTiddler(this._widget.attributes.tiddler);
    console.log("attached to tiddler:");
    console.log(this._tiddler);
    
    this._areaNode = areaNode;
    this._sibling  = (typeof sibling !== 'undefined') ?  sibling : this._areaNode;
    this._offTop = (typeof offTop !== 'undefined') ?  offTop : 0;
    this._offLeft = (typeof offLeft !== 'undefined') ?  offLeft : 0;	
		
    // this is a state machine.
    this._state = STATE_VOID;
    this._template = undefined;

    /** Best matches */
    this._bestMatches = []; // An array of OptCompletion
    this._idxChoice = -1;

    /** Param */
    // maximum nb of match displayed
    this._maxMatch = param.configuration.maxMatch || DEFEAULT_MAX_MATCH;
    this._minPatLength = param.configuration.minPatLength || DEFAULT_MIN_PATTERN_LENGTH;
    this._caseSensitive = param.configuration.caseSensitive || DEFAULT_CASE_SENSITIVE;
    this._triggerKeyMatcher = keyMatchGenerator(param.configuration.triggerKeyCombination || DEFAULT_TRIGGER_KEY_COMBO);
    /** Input information */
    this._lastChar = "";
    this._hasInput = false;

    this.source = null;
    this.sources = [
        new FilteringCompletionSource(
            this._wiki,
            this._tiddler,
            false, // case insensitive,
            5, // maximum matches
    	    new Template("[[", "[all[tiddlers]!is[system]]", "", "title", "[[", "]]")),
        new PDFNameCompletionSource(
            this._wiki,
            this._tiddler,
            false,
            10,
            new Template("[name[", null, "", null, "[name[", "]]")),
        // new PDFGraphicSource(
        //     this._wiki,
        //     this._tiddler,
        //     false,
        //     10,
        //     new Template("[fig[", null, "", null, "[fig[", "]]"))
    ];

    // todo: this will eventually leave this module, but keep it here for now.
    // start the process of parsing the default PDF (if there is one).
    
    // this.pdf = null;
    // this.paper = null;
    
    // var servedPDFPromise = null;
    // if (PDF_FIELD_NAME in this._tiddler.fields) {
    //     this.pdf = new ServedPDF(this._tiddler.fields[PDF_FIELD_NAME]);
    //     console.log("loading PDF with name " + this.pdf.name);
    //     servedPDFPromise = this.pdf.read();
    // }
    // else {
    //     servedPDFPromise = Promise.resolve(null);
    // }
    
    // servedPDFPromise.then(function() {
    //     if (this.pdf == null || this.pdf.title == null) {
    //         return;
    //     }

    //     if (!(FIELD_PDF_RETRIEVED in this._tiddler.fields) || REBUILD) {
    //         this.academicAPI.getPaper(this.pdf.title).then(function(papers) {
    //             let paperPromises = [];

    //             for (let paperIndex = 0; paperIndex < papers.length; paperIndex++) {
    //                 let paper = papers[paperIndex];
    //                 console.log(paper);

    //                 paperPromises.push(SemanticScholarAPI.resolve(paper));
    //             }

    //             return Promise.all(paperPromises);
    //         }).then(function(papers) {
    //             // at some point we might get > 1 and choose the "best". for now, pick the first.
    //             var match = papers[0];
    //             this._tiddler = AssociatePaperToTiddler(this._wiki, match, this._tiddler);
    //         }.bind(this));
    //     }

    //     // only expose the "paper" that can be reconstituted from the tiddler itself.
    //     this.paper = ParsePaperFromTiddler(this._wiki, this._tiddler, this.pdf.title);

    //     for (var sourceIndex = 0; sourceIndex < this.sources.length; sourceIndex++) {
    //         var source = this.sources[sourceIndex];
    //         source.pdf = this.pdf;
    //         source.paper = this.paper;
    //     }
    // }.bind(this));
        
    this.templates = [];
    for (var sourceIndex = 0; sourceIndex < this.sources.length; sourceIndex++) {
        var source = this.sources[sourceIndex];
        if (source.template != undefined || source.template != null) {
            this.templates.push(source.template);
        }
    }
    
    this._popNode = createPopup(this._widget, this._sibling);	
    
    // Listen to the Keyboard
    $tw.utils.addEventListeners( this._areaNode,[
	{name: "input", handlerObject: this, handlerMethod: "handleInput"},
	{name: "keydown", handlerObject: this, handlerMethod: "handleKeydown"},
	{name: "keypress", handlerObject: this, handlerMethod: "handleKeypress"},
    	{name: "keyup", handlerObject: this, handlerMethod: "handleKeyup"}
    ]);
   
    /**
     * Change Selected Status of Items
     */
    this._next = function (node) {
	var count = node.children.length;
	//DEBUG console.log( "__NEXT: co="+count+" nbMatch="+this._bestMatches.length);
	if( this._bestMatches.length > 0 ) 
	    this._goto( node, this._idxChoice < count - 1 ? this._idxChoice + 1 : -1);
	//DEBUG this._logStatus( "NexT" );
    };
    this._previous = function (node) {
	var count = node.children.length;
	var selected = this._idxChoice > -1;
	//DEBUG console.log( "__PREV: co="+count+" nbMatch="+this._bestMatches.length);
	if( this._bestMatches.length > 0 ) 
	    this._goto( node, selected ? this._idxChoice - 1 : count - 1);
	//DEBUG this._logStatus( "PreV" );
    };
    // Should not be used, highlights specific item without any checks!
    this._goto = function (node, idx) {
	var lis = node.children;
	var selected = this._idxChoice > -1;
	if (selected) {
	    lis[this._idxChoice].setAttribute("patt-selected", "false");
	}

	this._idxChoice = idx;
    
	if (idx > -1 && lis.length > 0) {
	    lis[idx].setAttribute("patt-selected", "true");
	}
    };
    /**
     * Abort pattern and undisplay.
     */
    this._abortPattern = function(displayNode) {
	this._state = STATE_VOID;
	this._idxChoice = -1;
	this._undisplay(displayNode);
	this._template = undefined;
        this.source = null;
    };
    /**
     * Display popupNode at the cursor position in areaNode.
     */
    this._display = function(areaNode, popupNode) {
	if (popupNode.style.display == 'none') {
	    // Must get coordinate
	    // Cursor coordinates within area + area coordinates + scroll
            var coord = getCaretCoordinates(areaNode, areaNode.selectionEnd);
            var styleSize = getComputedStyle(areaNode).getPropertyValue('font-size');
            var fontSize = parseFloat(styleSize); 
		
	    popupNode.style.left = (this._offLeft+areaNode.offsetLeft-areaNode.scrollLeft+coord.left) + 'px';
	    popupNode.style.top = (this._offTop+areaNode.offsetTop-areaNode.scrollTop+coord.top+fontSize*2) + 'px';
	    popupNode.style.display = 'block';
	}
    };
    /**
     * Undisplay someNode
     */
    this._undisplay = function(displayNode) {
	if (displayNode.style.display != 'none') {
	    displayNode.style.display = 'none';
	}
    };

     /**
     * Used for debug
     */
    this._logStatus = function(msg) {
	console.log("__STATUS: " + this._state + ":-" + msg + "- idx=" + this._idxChoice);
    };
};
// **************************************************************************
// ******************************************************************eventCbk
// **************************************************************************
/**
 * Disable the *effects* of ENTER / UP / DOWN / ESC when needed.
 * Set _hasInput to false.
 */
Completion.prototype.handleKeydown = function(event) {
    // key 
    var key = event.keyCode;
    this._hasInput = false;
    
    //DEBUG console.log( "__KEYDOWN ("+key+") hasI="+this._hasInput);
    
    // ENTER while selecting
    if ((this._state === STATE_PATTERN || this._state === STATE_SELECT) && key === KEYCODE_ENTER) {
    	event.preventDefault();
    	event.stopPropagation();
    }
    // ESC while selecting
    if ((this._state === STATE_PATTERN || this._state === STATE_SELECT) && key === KEYCODE_ESCAPE) {
    	event.preventDefault();
    	event.stopPropagation();
    }
    // UP/DOWN while a pattern is extracted
    if ((key === KEYCODE_UP || key === KEYCODE_DOWN) && 
	(this._state === STATE_PATTERN || this._state === STATE_SELECT)) {
	event.preventDefault();
    }
};
/**
 * Means that something has been added/deleted => set _hasInput
 */
Completion.prototype.handleInput = function(event) {
    this._hasInput = true;
    //DEBUG console.log( "__INPUT hasI="+this._hasInput );
};
	
/**
 * Set _lastChar, detects CTRL+SPACE.
 */
Completion.prototype.handleKeypress = function(event) {
    var curPos = this._areaNode.selectionStart;  // cursor position
    var val = this._areaNode.value;   // text in the area
    var key = event.keyCode || event.which;
	
    this._lastChar = String.fromCharCode(key);
    //DEBUG console.log( "__KEYPRESS ("+key+") hasI="+this._hasInput+" char="+this._lastChar );
    //DEBUG this._logStatus( "KEYPRESS" );
    
    // Detect Ctrl+Space
    if(this._triggerKeyMatcher(event) && this._state === STATE_VOID) {
        // match to a template.
	if( this._template === undefined ) {
	    //DEBUG console.log("__SPACE : find a Template" );
	    var idT, res;
	    for (idT = 0; idT < this.templates.length; idT++) {
		res = extractPattern(val, curPos, this.templates[idT]);
		// res is not undefined => good template candidate
		if (res) {
		    this._template = this.templates[idT];
		    this._state = STATE_PATTERN;
		    break;
		}
	    }
	}
	else {
	    //DEBUG console.log("__SPACE : already a template" );
	    this._state = STATE_PATTERN;
	}
    }
};
/**
 * ESC -> abort; 
 * Detect [ -> VOID switch to _state=PATTERN
 * PATTERN || SELECT : ENTER -> insertText
 *                     UP/DOWN -> previous/next
 *                     pattern.length > _minPatternLength -> display  
 */

var KEYCODE_ENTER = 13;
var KEYCODE_ESCAPE = 27;
var KEYCODE_UP = 38;
var KEYCODE_DOWN = 40;
    
Completion.prototype.handleKeyup = function(event) {
    var curPos = this._areaNode.selectionStart;  // cursor position
    var val = this._areaNode.value;   // text in the area
    var key = event.keyCode;
    

    if (key === KEYCODE_ESCAPE) {
	this._abortPattern(this._popNode);
        // do we want to return?
        //return;
    }

    // something has been entered and we're not locked in "pattern" mode.
    if (this._hasInput && this._state === STATE_VOID) {
        for (var templateIndex = 0; templateIndex < this.templates.length; templateIndex++) {
            var template = this.templates[templateIndex];

            console.log("value:");
            console.log(val);

            console.log("cur pos:")
            console.log(curPos);

            var matchIndex = curPos - 1;
            var patternIndex = template.pat.length - 1;

            // probably better matching algorithms.
            while ((matchIndex >= 0) && (patternIndex >= 0)) {
                if (val[matchIndex] != template.pat[patternIndex]) {
                    break;
                }

                patternIndex--;
                matchIndex--;
            }

            if (patternIndex == -1) {
		this._state = STATE_PATTERN;
		this._template = template;
                console.log("matched!");
                this.source = this.sources[templateIndex];
                console.log(this.source);
                // match.

                break;
            }
            
            // if (this._lastChar === template.pat[template.pos]) {
	    //     template.pos += 1;
	    //     //DEBUG console.log( "__CHECK : pat="+template.pat+" pos="+template.pos );
	    //     // Pattern totaly matched ?
	    //     if (template.pos === template.pat.length) {
	    //         //DEBUG console.log( "__CHECK => found "+template.pat );
	    //         this._state = STATE_PATTERN;
	    //         this._template = template;
            //         this.source = this.sources[templateIndex];

            //         // this is an interesting choice because we don't know
            //         // how the user will interact e.g. erasing versus backspace
            //         // should invalidate this code. my guess is that this code should
            //         // look _back_ at any given instance to see if they can match a template.
		    
	    //         break; // get out of loop
	    //     }
	    // }
	    // else {
	    //     template.pos = 0;
	    //     //DEBUG console.log( "__CHECK : pat="+template.pat+" pos="+template.pos );
	    // }            
        }
    }
    // a pattern
    else if (this._state === STATE_PATTERN || this._state === STATE_SELECT) {
	// Pattern below cursor : undefined if no pattern
	var pattern = extractPattern(val, curPos, this._template);

        if (key === KEYCODE_ENTER) {
    	    var selected = this._idxChoice > -1 && this._idxChoice !== this._maxMatch;

    	    if (selected) {
		var match = this._bestMatches[this._idxChoice];
                var completed = this.source.completed(match);
                
    		insertInto(
                    this._areaNode, completed, pattern.start, curPos, this._template);
		this._widget.saveChanges(this._areaNode.value);
	    }
	    // otherwise take the first choice (if exists)
	    else if (this._bestMatches.length > 0) {
    		//DEBUG console.log( "   > take first one" );
		var match = this._bestMatches[0];

                // determines what actually gets written.
                var completed = this.source.completed(match);
                
    		insertInto(
                    this._areaNode, completed, pattern.start, curPos, this._template);
		this._widget.saveChanges(this._areaNode.value);
	    }

            this._abortPattern(this._popNode);
    	}
	else if (key === KEYCODE_UP && this._hasInput === false) { // up
	    this._state = STATE_SELECT;
    	    event.preventDefault();
    	    this._previous(this._popNode);
    	    //event.stopPropagation();
    	}
    	else if (key === KEYCODE_DOWN && this._hasInput === false) { // down
	    this._state = STATE_SELECT;
    	    event.preventDefault();
    	    this._next(this._popNode);
    	    //event.stopPropagation();
    	}
    	else if (pattern) { // pattern changed by keypressed
	    this._idxChoice = -1;

	    if(pattern.text.length > (this._minPatLength - 1)) {
                console.log("attempting to complete: " + pattern.text);
		this._bestMatches = this.source.complete(pattern.text);
                
    		this._popNode.innerHTML = "";

                //console.log( "BC "+ this._pattern + " => " + choice );
    		if (this._bestMatches.length > 0) {
		    for (var i = 0; i < this._bestMatches.length; i++) {
    			this._popNode.appendChild( 
			    itemHTML(this._bestMatches[i].str, pattern.text));
    		    }
                    
                    this._display( this._areaNode, this._popNode );			
    		}
		else {
                    // still looking for some pattern.
		    this._state = STATE_PATTERN;
		    this._undisplay(this._popNode);
		}
	    }
    	}
	else { // no pattern detected
	    this._abortPattern(this._popNode);
	}
    }

    // to ensure that one MUST add an input (through onInput())
    this._hasInput = false;
};
// **************************************************************************
// ******************************************************** private functions
// **************************************************************************
/**
 * Create popup element.
 */
var createPopup = function( widget, node ) {
    // Insert a special "div" element for poping up
    // Its 'display' property in 'style' control its visibility
    var popupNode = widget.document.createElement("div");
    popupNode.setAttribute( "style", "display:none; position: absolute;");
    popupNode.className = "tc-block-dropdown ect-block-dropdown";
    // Insert the element into the DOM
    node.parentNode.insertBefore(popupNode,node.nextSibling);
    //CHECK the domNodes is a attribute of Widget [widget.js]
    //CHECK this.domNodes.push(popupNode);
    
    return popupNode;
};
/**
 * Extract Pattern from text at a given position.
 *
 * Between previous template.pat (or '[[') and pos
 * 
 * If no pattern -> undefined
 */
var extractPattern = function( text, pos, template ) {
    // Detect previous and next ]]=>STOP or [[=>START
    var sPat = template.pat ? template.pat : '[[';
    var pos_prevOpen = text.lastIndexOf( sPat, pos );
    var ePat = template.end ? template.end : ']]';
    var pos_prevClosed = text.lastIndexOf( ePat, pos );
    var pos_nextClosed = text.indexOf( ePat, pos  );
    //DEBUG console.log("__CALC st="+sPat+" -> en="+ePat );
    //DEBUG console.log("__CALC po="+pos_prevOpen+" pc="+pos_prevClosed+" nc="+pos_nextClosed+" pos="+pos);
    pos_nextClosed = (pos_nextClosed >= 0) ? pos_nextClosed : pos;
    
    if( (pos_prevOpen >= 0) &&                 // must be opened
	((pos_prevOpen > pos_prevClosed ) ||  // not closed yet
	 (pos_prevClosed === pos))) {          // closed at cursor
	//DEBUG console.log("     pat="+text.slice( pos_prevOpen+sPat.length, pos) );
	return { text: text.slice( pos_prevOpen+sPat.length, pos ),
		 start: pos_prevOpen,
		 end: pos_nextClosed
	       };
    }
};
/**
 * Controls how list items are generated.
 * Function that takes two parameters :
 *  - text : suggestion text
 *  - input : the user’s input
 * Returns : list item. 
 * Generates list items with the user’s input highlighted via <mark>.
 */
var itemHTML = function (text, input ) {
    // text si input === ''
    // otherwise, build RegExp that is global (g) and case insensitive (i)
    // to replace with <mark>$&</mark> where "$&" is the matched pattern
    var html = input === '' ? text : text.replace(RegExp(regExpEscape(input.trim()), "gi"), "<mark>$&</mark>");
    return create("li", {
	innerHTML: html,
	"patt-selected": "false"
    });
};
/**
 * Insert text into a textarea node, 
 * enclosing in 'template.start..template.end'
 *
 * - posBefore : where the 'template.pat+pattern' starts
 * - posAfter : where the cursor currently is
 */
var insertInto = function(node, text, posBefore, posAfter, template ) {
    //DEBUG console.log( "__INSERT : "+template.pattern+":"+template.filter+":"+template.mask+":"+template.field+":"+template.start+":"+template.end );
    var val = node.value;
    var sStart = template.start !== undefined ? template.start : '[[';
    var sEnd = template.end !== undefined ? template.end : ']]';
    var newVal = val.slice(0, posBefore) + text + val.slice(posAfter);
    // sStart + text + sEnd + val.slice(posAfter);
    //console.log("__INSERT s="+sStart+" e="+sEnd);
    //console.log ("__INSERT pb="+posBefore+" pa="+posAfter+" txt="+text);
    //console.log( "NEW VAL = "+newVal );
    // WARN : Directly modifie domNode.value.
    // Not sure it does not short-circuit other update methods of the domNode....
    // i.e. could use widget.updateEditor(newVal) from edit-comptext widget.
    //      but how to be sure that cursor is well positionned ?
    node.value = newVal;
    node.setSelectionRange(posBefore + text.length, posBefore + text.length);
    //node.setSelectionRange(posBefore+text.length+sStart.length+sEnd.length, posBefore+text.length+sStart.length+sEnd.length );
};
/**
 * Add an '\' in front of -\^$*+?.()|[]{}
 */
var regExpEscape = function (s) {
    return s.replace(/[-\\^$*+?.()|[\]{}]/g, "\\$&");
};

var create = function(tag, o) {
    var element = document.createElement(tag);
    
    for (var i in o) {
	var val = o[i];
	
	if (i === "inside") {
	    $(val).appendChild(element);
	}
	else if (i === "around") {
	    var ref = $(val);
	    ref.parentNode.insertBefore(element, ref);
	    element.appendChild(ref);
	}
	else if (i in element) {
	    element[i] = val;
	}
	else {
	    element.setAttribute(i, val);
	}
    }
    
    return element;
};


exports.Completion = Completion;

})();

    
