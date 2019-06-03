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

// PDF API.
var pdfapi = require("$:/plugins/jlazarow/pdfserve/pdfapi.js");

var PAPER_PREFIX = "$:/paper/";    
    
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

function highlightMatchingText(text, partial) {
    return partial === "" ? text : text.replace(RegExp(regExpEscape(partial.trim()), "gi"), "<mark>$&</mark>");
}
    
function CompletedItem(title) {
    this.title = title;
}

CompletedItem.prototype.getElement = function(partial) {
    var li = document.createElement("li");
    var span = document.createElement("span");

    span.innerHTML = highlightMatchingText(this.title, partial);
    li.setAttribute("patt-selected", "false");

    li.appendChild(span);
    return li;
}
    
CompletedItem.prototype.getInsertionText = function() {
    return this.title;
}
    
// indicates that calling wiki.getTiddler will work.
function CompletedTiddlerItem(title) {
    CompletedItem.call(this, title);

    this.tiddler = null;
}

CompletedTiddlerItem.prototype = Object.create(CompletedItem.prototype);
CompletedTiddlerItem.prototype.constructor = CompletedTiddlerItem;

CompletedTiddlerItem.prototype.getElement = function(partial) {
    var li = document.createElement("li");
    var span = document.createElement("span");

    if (this.tiddler == null) {
        this.tiddler = $tw.wiki.getTiddler(this.title);
    }

    var displayTitle = this.title;

    // this might break partial highlighting for now.
    if ("caption" in this.tiddler.fields) {
        displayTitle = this.tiddler.fields.caption;
    }
    
    span.innerHTML = highlightMatchingText(displayTitle, partial);
    li.setAttribute("patt-selected", "false");
    li.appendChild(span);
    
    return li;
}

CompletedTiddlerItem.prototype.getInsertionText = function() {
    // only support inserting references for now.
    return "[](#" + this.title + ")";
}
    
function CompletedPDFOutlineItem(pdf, item) {
    CompletedItem.call(this, item.title);

    this.pdf = pdf;
    this.item = item;
}

CompletedPDFOutlineItem.prototype.getInsertionText = function() {
    return "[](" + this.pdf.name + "#" + this.item.destination + ")";    
}
    
function CompletedPaperReferenceItem(associated) {
    CompletedItem.call(this, associated.reference.paper.title);

    this.associated = associated;
}
    
CompletedPaperReferenceItem.prototype = Object.create(CompletedItem.prototype);
CompletedPaperReferenceItem.prototype.constructor = CompletedPaperReferenceItem;

CompletedPaperReferenceItem.prototype.getElement = function(partial) {
    var text = this.title;
    var influential = this.associated.reference.isInfluential;

    var element = document.createElement("li");
    if (influential) {
        var influentialSpan = document.createElement("span");
        influentialSpan.innerHTML = "Highly Influential";
        influentialSpan.style.borderWidth = "1px";
        influentialSpan.style.borderStyle = "solid";
        influentialSpan.style.borderColor = "#dd913f";
        influentialSpan.style.color = "#dd913f";
        influentialSpan.style.paddingLeft = "7.5px";
        influentialSpan.style.paddingRight = "7.5px";
        influentialSpan.style.marginRight = "6px";

        element.appendChild(influentialSpan);
    }

    // missing.
    var missing = this.associated.tiddlerTitle.startsWith(PAPER_PREFIX);
    if (missing) {
        var missingSpan = document.createElement("span");
        missingSpan.innerHTML = "Missing";
        missingSpan.style.borderWidth = "1px";
        missingSpan.style.borderStyle = "solid";
        missingSpan.style.borderColor = "#bd2031";
        missingSpan.style.color = "#bd2031";
        missingSpan.style.paddingLeft = "7.5px";
        missingSpan.style.paddingRight = "7.5px";
        missingSpan.style.marginRight = "6px";

        element.appendChild(missingSpan);
    }

    var patternSpan = document.createElement("span");
    patternSpan.id = "actual-text";
    patternSpan.innerHTML = partial === '' ? text : text.replace(RegExp(regExpEscape(partial.trim()), "gi"), "<mark>$&</mark>");
    element.appendChild(patternSpan);
    element.setAttribute("patt-selected", "false");
    
    return element;    
}

CompletedPaperReferenceItem.prototype.getInsertionText = function() {
    // this will be a bit of a magical endpoint. if the user selects a paper
    // that is unknown to the wiki, we will download it and add it.

    return "[" + this.title + "](#" + this.associated.tiddlerTitle + ")";
}
    
function SpacerCompletedItem() {
    CompletedItem.call(this, null);
}

SpacerCompletedItem.prototype = Object.create(CompletedItem.prototype);
SpacerCompletedItem.prototype.constructor = SpacerCompletedItem;

SpacerCompletedItem.prototype.getElement = function(partial) {
    var li = document.createElement("li");
    var hr = document.createElement("hr");
    
    li.setAttribute("patt-selected", "false");
    li.appendChild(hr);
        
    return li;
}

SpacerCompletedItem.prototype.getInsertionText = function() {
    throw "spacer items cannot be inserted";
}
        
function EllipsisCompletedItem() {
    CompletedItem.call(this, "...");
}

EllipsisCompletedItem.prototype = Object.create(CompletedItem.prototype);
EllipsisCompletedItem.prototype.constructor = EllipsisCompletedItem;

EllipsisCompletedItem.prototype.getElement = function(partial) {
    var li = document.createElement("li");
    var span = document.createElement("span");
    span.innerHTML = "...";
    
    li.setAttribute("patt-selected", "false");
    li.appendChild(span);
        
    return li;
}

EllipsisCompletedItem.prototype.getInsertionText = function() {
    throw "ellipsis items cannot be inserted";
}
    
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

function CompletionSource(wiki, tiddler, caseSensitive, maximumMatches) {
    this.wiki = wiki;
    this.tiddler = tiddler;
    this.caseSensitive = caseSensitive;
    this.maximumMatches = maximumMatches;
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

    var numberMatches = 0;

    var bestMatches = [];
    var otherMatches = []

    for (var completionIndex = 0; completionIndex < completions.length; completionIndex++) {
        var completion = completions[completionIndex];
        var title = completion.title;

        // good matches _begin_ with the pattern. I think this should just
        // be re-factored to take the "found index" and compute a score from
        // that. leaving like this for now.
 	if (regexPatternStart.test(title)) {
	    if (numberMatches >= limit) {
                // I guess reserve the last one for "more".
		bestMatches.push(new EllipsisCompletedItem());
		return bestMatches;
	    } else {
		bestMatches.push(completion);
		numberMatches += 1;
	    }
	}
	else if (regexPattern.test(title)) {
            // then if pattern is found WITHIN the maskedChoice
	    // added AFTER the choices that starts with pattern
	    if (numberMatches >= limit) {
                // finish things off. this should really just be a "break"
		bestMatches.push(completion);
		bestMatches = bestMatches.concat(otherMatches);
		bestMatches.push(new EllipsisCompletedItem());

                return bestMatches;
	    } else {
		otherMatches.push(completion);
                //otherMatches.push(new CompletionItem(completion.title, maskedTitle, false));
		numberMatches += 1;
	    }
	}
    }

    // Here, must add the otherMatches
    bestMatches.push(new SpacerCompletedItem());
    bestMatches = bestMatches.concat(otherMatches);

    // would rather "return" this. my guess is the previous code might
    // be hitting weirdness if threads exist.
    return bestMatches;
}

// preserving the original tiddler based implementation.
// I think this needs a "term"?    
function FilteringCompletionSource(wiki, tiddler, caseSensitive, maximumMatches, template) {
    CompletionSource.call(this, wiki, tiddler, caseSensitive, maximumMatches);

    this.template = template || null;
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
        items.push(new CompletedTiddlerItem(matchingNames[nameIndex]));
    }
    
    return this.rank(items, partial, limit);
}

// we should have something that also tries to partially populate it from
// TiddlyWiki itself.    
function PDFNameCompletionSource(wiki, tiddler, caseSensitive, maximumMatches, template, pdf) {
    CompletionSource.call(this, wiki, tiddler, caseSensitive, maximumMatches);

    this.template = template || null;
    this.pdf = pdf;
}

PDFNameCompletionSource.prototype = Object.create(CompletionSource.prototype);
PDFNameCompletionSource.prototype.constructor = PDFNameCompletionSource;
        
PDFNameCompletionSource.prototype.complete = function(partial, limit) {
    console.log("PDFNameCompletionSource.complete()");
    console.log(partial);

    // this will be a little more complicated. we're interested in:
    // "named destinations" (e.g. outline).
    // "images/graphs".
    // for now just complete against the default PDF with the outline.

    var items = [];
    if (this.pdf.outline != null) {
        var flattened = this.pdf.outline.getFlattened();

        for (var outlineIndex = 0; outlineIndex < flattened.length; outlineIndex++) {
            var outlineItem = flattened[outlineIndex];
            items.push(new CompletedPDFOutlineItem(this.pdf, outlineItem));
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

    return this.rank(items, partial, limit);
}

function AssociatedPaperReference(reference, tiddlerTitle) {
    this.reference = reference;
    this.tiddlerTitle = tiddlerTitle;
}
    
function PaperReferencesCompletionSource(wiki, tiddler, caseSensitive, maximumMatches, template, paper) {
    CompletionSource.call(this, wiki, tiddler, caseSensitive, maximumMatches);

    this.template = template || null;
    this.paper = paper;
    
    this.references = [];
    this.influential = {};
    this.indexReferences(this.paper);
}

PaperReferencesCompletionSource.prototype = Object.create(CompletionSource.prototype);
PaperReferencesCompletionSource.prototype.constructor = PaperReferencesCompletionSource;

PaperReferencesCompletionSource.prototype.indexReferences = function(paper) {
    var references = paper.references;
    if (references.length == 0) {
        return;
    }

    for (var referenceIndex = 0; referenceIndex < references.length; referenceIndex++) {
        var reference = references[referenceIndex];

        // unsure why this is happening.
        if (reference.paper == null) {
            console.log("null paper??");
            continue;
        }
        
        var referenceParts = reference.paper.id.split(":");
        var referenceType = referenceParts[0];
        console.log("ref of type " + referenceType + " value " + reference.paper.id);
        var matchingNames = this.wiki.filterTiddlers("[!has[draft.of]field:" + referenceType + "[" + reference.paper.id + "]]");
        var matchingName = null;
        if (matchingNames.length > 0) {
            matchingName = matchingNames[0];
        }

        this.references.push(
            new AssociatedPaperReference(reference, matchingName));
    }

    console.log("resolved references");
    console.log(this.references);
}

PaperReferencesCompletionSource.prototype.rank = function(completions, partial, limit) {
    console.log("PaperReferences.rank " + partial);
    console.log(partial.length);
    
    if (partial.length == 0) {
        limit = limit || this.maximumMatches;

        // sort by "isInfluential".
        completions = completions.sort(function(a, b) {
            // sort alphabetical.
            var aInfluential = a.associated.reference.isInfluential;
            var bInfluential = b.associated.reference.isInfluential;
            if (aInfluential && !bInfluential) {
                return -1;
            }

            if (bInfluential && !aInfluential) {
                return 1;
            }

            return a.title.localeCompare(b.title);
        });

        var bestMatches = completions.slice(0, limit);
        bestMatches.push(new EllipsisCompletedItem());

        return bestMatches;
    }
 
    return CompletionSource.prototype.rank.call(this, completions, partial, limit);
}    
        
PaperReferencesCompletionSource.prototype.complete = function(partial, limit) {
    console.log("PaperReferencesCompletionSource.complete()");
    console.log(partial);

    // this will be a little more complicated. we're interested in:
    // "named destinations" (e.g. outline).
    // "images/graphs".
    // for now just complete against the default PDF with the outline.

    var items = [];

    // each each referenced paper..
    console.log("completing " + this.references.length + " references");
    for (var referenceIndex = 0; referenceIndex < this.references.length; referenceIndex++) {
        items.push(new CompletedPaperReferenceItem(this.references[referenceIndex]));
    }

    if (items.length == 0) {
        return [];
    }

    return this.rank(items, partial, limit);
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
    this._matchedPosition = -1;
    
    /** Best matches */
    this._bestMatches = []; // An array of OptCompletion
    this._idxChoice = -1;

    /** Param */
    // maximum nb of match displayed
    this._maxMatch = param.configuration.maxMatch || DEFEAULT_MAX_MATCH;
    this._minPatLength = 0; // param.configuration.minPatLength || DEFAULT_MIN_PATTERN_LENGTH;
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
        // new PDFNameCompletionSource(
        //     this._wiki,
        //     this._tiddler,
        //     false,
        //     10,
        //     new Template("[name[", null, "", null, "[name[", "]]")),
        // new PDFGraphicSource(
        //     this._wiki,
        //     this._tiddler,
        //     false,
        //     10,
        //     new Template("[fig[", null, "", null, "[fig[", "]]"))
    ];

    // see if any PDF exists.
    if ("pdf" in this._tiddler.fields) {
        var pdf = $tw.pdfs.getPDF(this._tiddler.fields.pdf);
        var paper = $tw.papers.getPaper(this._tiddler.fields.title);
        
        if (pdf) {
            console.log("attaching PDF completions");
            this.sources.push(new PDFNameCompletionSource(
                this._wiki,
                this._tiddler,
                false,
                10,
                new Template("[name[", null, "", null, "[name[", "]]"),
                pdf));
        }
        else {
            console.log("no PDF found");
        }

        if (paper) {
            console.log("attaching paper completions");
            this.sources.push(new PaperReferencesCompletionSource(
                this._wiki,
                this._tiddler,
                false,
                25,
                new Template("[ref[", null, "", null, "[ref[", "]]"),
                paper));
        }
    }

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

Completion.matchesTemplate = function(template, value, currentPosition) {
    var matchIndex = currentPosition - 1;
    var patternIndex = template.pat.length - 1;

    // probably better matching algorithms.
    while ((matchIndex >= 0) && (patternIndex >= 0)) {
        if (value[matchIndex] != template.pat[patternIndex]) {
            return false
        }

        patternIndex--;
        matchIndex--;
    }

    return true;
}
    
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

            if (Completion.matchesTemplate(template, val, curPos)) {
		this._state = STATE_PATTERN;
	        this._template = template;
                // hack to fix this for now.
                this._matchedPosition = curPos;
                console.log("matched!");
                this.source = this.sources[templateIndex];
                console.log(this.source);

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
    if (this._state === STATE_PATTERN || this._state === STATE_SELECT) {
        // make sure we're still in the game.
        if (curPos < this._matchedPosition) {
            this._abortPattern(this._popNode);
            this._hasInput = false;
            return;
        }
        
        console.log("in pattern mode with min length " + this._minPatLength);
	// Pattern below cursor : undefined if no pattern
	var pattern = extractPattern(val, curPos, this._template);
        if (!pattern) {
            this._state = STATE_VOID;
            return;
        }

        if (key === KEYCODE_ENTER) {
    	    var selected = this._idxChoice > -1 && this._idxChoice !== this._maxMatch;

    	    if (selected) {
		var match = this._bestMatches[this._idxChoice];
                var completed = match.getInsertionText();
                
    		insertInto(
                    this._areaNode, completed, pattern.start, curPos, this._template);
		this._widget.saveChanges(this._areaNode.value);
	    }
	    // otherwise take the first choice (if exists)
	    else if (this._bestMatches.length > 0) {
    		//DEBUG console.log( "   > take first one" );
		var match = this._bestMatches[0];

                // determines what actually gets written.
                var completed = match.getInsertionText();
                
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
    	else if (pattern || (this._minPatLength == 0)) { // pattern changed by keypressed
	    this._idxChoice = -1;

            pattern = pattern || "";

	    if(pattern.text.length > (this._minPatLength - 1)) {
                console.log("attempting to complete: " + pattern.text);
		this._bestMatches = this.source.complete(pattern.text);
                
    		this._popNode.innerHTML = "";

                //console.log( "BC "+ this._pattern + " => " + choice );
    		if (this._bestMatches.length > 0) {
		    for (var i = 0; i < this._bestMatches.length; i++) {
                        let currentMatch = this._bestMatches[i];
    			this._popNode.appendChild(currentMatch.getElement(pattern.text));
    		    }
                    
                    this._display(this._areaNode, this._popNode);			
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
var createPopup = function(widget, node) {
    // Insert a special "div" element for poping up
    // Its 'display' property in 'style' control its visibility
    var popupNode = widget.document.createElement("div");
    popupNode.setAttribute( "style", "display:none; position: absolute;");
    popupNode.className = "tc-block-dropdown ect-block-dropdown";
    // Insert the element into the DOM
    node.parentNode.insertBefore(popupNode, node.nextSibling);
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
 * Insert text into a textarea node, 
 * enclosing in 'template.start..template.end'
 *
 * - posBefore : where the 'template.pat+pattern' starts
 * - posAfter : where the cursor currently is
 */
var insertInto = function(node, text, posBefore, posAfter, template) {
    var val = node.value;
    var sStart = template.start !== undefined ? template.start : '[[';
    var sEnd = template.end !== undefined ? template.end : ']]';
    var newVal = val.slice(0, posBefore) + text + val.slice(posAfter);
    node.value = newVal;
    node.setSelectionRange(posBefore + text.length, posBefore + text.length);
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

    
