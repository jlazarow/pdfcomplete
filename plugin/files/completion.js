/**
title: $:/plugins/snowgoon88/edit-comptext/completion.js
type: application/javascript
module-type: widget
*/
/**
 * Completion object as used by edit-comptext TW5 widget.
 * Hope this can nearly constitute a 'stand-alone' completion module.
 *
 * @author Alain Dutech snowgoon88ATgmailDOTcom
 *
 * Two Behavior
 * - detect that 2 '[' are typed : PATTERN
 * - CTRL+SPACE : PATTERN (if any)
 * - ESC returns to VOID
 *
 * In any case, pattern is 'Template.pat'->cursorPos.
 * _state : VOID -> (PATTERN -> (SELECT -> VOID) | VOID)
 * 
 * TODO : some clean up.
 */
(function(){

var Completion = function( display, undisplay, wiki, listTemplates) {
    this.wiki = wiki;
    /** How many opened '[' */
    this._nbSquareParen = 0;
    /** State */
    this._state = "VOID";
    this._template = undefined;
    /** Best matches */
    this._bestMatches = [];
    this._idxChoice = -1;
    /** Options */
    this._maxMatch = 5;   // maximum nb of match displayed
    this._minPatLen = 2;
    this._caseSensitive = false;
    /** Input information */
    this._lastChar = "";
    this._hasInput = false;
    /** Display and Undisplay function */
    this._display = display;
    this._undisplay = undisplay;
    /** 
     * Structure pour pattern plus génériques
     */
    var Template = function( pat, filter, start, end ) {
	this.pat = pat;
	this.filter = filter;
	this.start = start;
	this.end = end;
	this.pos = 0;
    };
    this._listTemp = [];
    // Read templates from config file
    if( listTemplates ) {
	var idT;
	for( idT=0; idT<listTemplates.length; idT++ ) {
	    var temp = listTemplates[idT];
	    //DEBUG console.log( "__CONF : "+temp.pattern+":"+temp.filter+":"+temp.start+":"+temp.end );
	    this._listTemp.push( 
		new Template( temp.pattern,
			      temp.filter,
			      temp.start,
			      temp.end )
		);
	}
    }
    // or defaut template
    else {
	this._listTemp = [
	    new Template( "[[", "[all[tiddlers]!is[system]]", "[[", "]]" )
	];
    }

    /** 
     * Find the bestMatches among listChoice with given pattern
     */
    this._findBestMatches = function( listChoice, pattern, nbMax) {
	// regexp search pattern, case sensitive
	var flagSearch = this._caseSensitive ? "" : "i" ;
	var regpat = RegExp( this._regExpEscape(pattern), flagSearch );
	var nbMatch = 0;
	// nbMax set to _maxMatch if no value given
	nbMax = nbMax !== undefined ? nbMax : this._maxMatch;

	this._bestMatches= [];
	for( var i=0; i< listChoice.length; i++ ) {
	    //DEBUG console.log( "__FIND: "+listChoice[i]+ " w "+pattern +" ?" );
	    // is the regular expression found
	    if( regpat.test( listChoice[i]) ) {
		if (nbMatch >= nbMax) {
		    this._bestMatches.push( "..." );
		    return;
		} else {
		    this._bestMatches.push( listChoice[i] );
		    nbMatch += 1;
		}
	    }
	}
    };
    /**
     * Extract Pattern from text at a give position.
     *
     * Between previous template.pat (or '[[') and pos
     * 
     * If no pattern -> undefined
     */
    this._extractPattern = function( text, pos, template ) {
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
	    console.log("     pat="+text.slice( pos_prevOpen+sPat.length, pos) );
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
    this._itemHTML = function (text, input ) {
	// text si input === ''
	// otherwise, build RegExp that is global (g) and case insensitive (i)
	// to replace with <mark>$&</mark> where "$&" is the matched pattern
	var html = input === '' ? text : text.replace(RegExp(this._regExpEscape(input.trim()), "gi"), "<mark>$&</mark>");
	return this._create("li", {
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
    this._insertInto = function(node, text, posBefore, posAfter, template ) {
	var val = node.value;
	var sStart = template.start ? template.start : '[[';
	var sEnd = template.end ? template.end : ']]';
	var newVal = val.slice(0, posBefore) + sStart + text + sEnd + val.slice(posAfter);
	//console.log ("__INSERT pb="+posBefore+" pa="+posAfter+" txt="+text);
	//console.log( "NEW VAL = "+newVal );
	// WARN : Directly modifie domNode.value.
	// Not sure it does not short-circuit other update methods of the domNode....
	node.value = newVal;
	node.setSelectionRange(posBefore+text.length+sStart.length+sEnd.length, posBefore+text.length+sStart.length+sEnd.length );
    };
    /**
     * Add an '\' in front of -\^$*+?.()|[]{}
     */
    this._regExpEscape = function (s) {
	return s.replace(/[-\\^$*+?.()|[\]{}]/g, "\\$&");
    };
    /**
     * Add an element in the DOM.
     */
    this._create = function(tag, o) {
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
    this._abortPattern = function (displayNode) {
	this._state = "VOID";
	this._nbSquareParen = 0;
	this._bestChoices = [];
	this._idxChoice = -1;
	this._undisplay( null, displayNode );
	this._template = undefined;
    };
    // **************************************************************************
    // ******************************************************************eventCbk
    // **************************************************************************
    /**
     * Disable the *effects* of ENTER / UP / DOWN / ESC when needed.
     * Set _hasInput to false.
     */
    this._onKeyDown = function(event) {
	// key 
	var key = event.keyCode;
	this._hasInput = false;

	//DEBUG console.log( "__KEYDOWN ("+key+") hasI="+this._hasInput);
	
	// ENTER while selecting
	if( (this._state === "PATTERN" || this._state === "SELECT") && key === 13 ) {
    	    event.preventDefault();
    	    event.stopPropagation();
	}
	// ESC while selecting
	if( (this._state === "PATTERN" || this._state === "SELECT") && key === 27 ) {
    	    event.preventDefault();
    	    event.stopPropagation();
	}
	// UP/DOWN while a pattern is extracted
	if( (key===38 || key===40) && 
	    (this._state === "PATTERN" || this._state === "SELECT") ) {
	    event.preventDefault();
	}
    };
    /**
     * Means that something has been added/deleted => set _hasInput
     */
    this._onInput = function(event) {
	this._hasInput = true;
	//DEBUG console.log( "__INPUT hasI="+this._hasInput );
    };	
    /**
     * Set _lastChar, detects CTRL+SPACE.
     */
    this._onKeyPress = function(event, areaNode) {
	var curPos = areaNode.selectionStart;  // cursor position
	var val = areaNode.value;   // text in the area
	// key 
	var key = event.keyCode || event.which;
	
	this._lastChar = String.fromCharCode(key);
	//DEBUG console.log( "__KEYPRESS ("+key+") hasI="+this._hasInput+" char="+this._lastChar );
	//DEBUG this._logStatus( "KEYPRESS" );
    
	// Détecter Ctrl+Space
	if( key === 32 && event.ctrlKey && this._state === "VOID" ) {
	    //Find a proper Template
	    // first from which we can extract a pattern
	    if( this._template === undefined ) {
		//DEBUG console.log("__SPACE : find a Template" );
		var idT, res;
		for( idT=0; idT < this._listTemp.length; idT++ ) {
		    res = this._extractPattern( val, curPos, this._listTemp[idT] );
		    //DEBUG console.log("  t="+this._listTemp[idT].pat+" res="+res);
		    // res is not undefined => good template candidate
		    if( res ) {
			this._template = this._listTemp[idT];
			this._state = "PATTERN";
			break;
		    }
		}
	    }
	    else {
		//DEBUG console.log("__SPACE : already a template" );
		this._state = "PATTERN";
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
    this._onKeyUp = function(event, listOptions, areaNode, displayNode ) {
	var curPos = areaNode.selectionStart;  // cursor position
	var val = areaNode.value;   // text in the area
	// key a
	var key = event.keyCode;
    
	//DEBUG console.log( "__KEYUP ("+key+") hasI="+this._hasInput );
	//TMP console.log( "__CHECK wiki="+this.wiki );
	//TMP console.log( "__CHECK filter="+this.wiki.filterTiddlers );

	// ESC
	if( key === 27 ) {
	    this._abortPattern( displayNode );
	    //DEBUG this._logStatus( "" );
	}
	// Check for every pattern
	if( this._hasInput && this._state === "VOID" ) {
	    // check every pattern
	    var idT, template;
	    for( idT=0; idT < this._listTemp.length; idT++ ) {
		template = this._listTemp[idT];
		if( this._lastChar === template.pat[template.pos] ) {
		    template.pos += 1;
		    console.log( "__CHECK : pat="+template.pat+" pos="+template.pos );
		    // Pattern totaly matched ?
		    if( template.pos === template.pat.length ) {
			console.log( "__CHECK => found "+template.pat );
			this._state = "PATTERN";
			this._template = template;

			break; // get out of loop
		    }
		}
		else {
		    template.pos = 0;
		    //DEBUG console.log( "__CHECK : pat="+template.pat+" pos="+template.pos );
		}
	    }
	}
	// a pattern
	else if( this._state === "PATTERN" || this._state === "SELECT" ) {
	    // Pattern below cursor : undefined if no pattern
	    var pattern = this._extractPattern( val, curPos, this._template );
	    if( key === 13 ) { // ENTER
		// console.log( "KEY : Enter" );
    		// Choice made in the displayNode ?
    		var selected = this._idxChoice > -1 && this._idxChoice !== this._maxMatch;
    		// console.log( "   > sel="+selected+" len="+this._bestChoices.length );
    		if( selected ) {
    		    //console.log( "   > selected" );
    		    this._insertInto( areaNode, this._bestMatches[this._idxChoice], pattern.start, curPos, this._template );
		}
    		else if( this._bestMatches.length === 1 ) {
    		    //console.log( "   > only one" );
    		    this._insertInto( areaNode, this._bestMatches[0], pattern.start, curPos, this._template );
		 }
		this._abortPattern( displayNode );
		//DEBUG this._logStatus( "" );
    	    }
	    else if( key === 38 && this._hasInput === false) { // up
		this._state = "SELECT";
    		event.preventDefault();
    		this._previous( displayNode );
		//DEBUG this._logStatus( pattern.text );
    		//event.stopPropagation();
    	    }
    	    else if( key === 40 && this._hasInput === false) { // down
		this._state = "SELECT";
    		event.preventDefault();
    		this._next( displayNode );
		//DEBUG this._logStatus( pattern.text );
    		//event.stopPropagation();
    	    }
    	    else if( pattern ) { // pattern changed by keypressed
		//var pattern = calcPattern( val, curPos );
		this._idxChoice = -1;
    		// log
		//DEBUG this._logStatus( pattern.text );
    		// Popup with choices if pattern at least two letters long
		if( pattern.text.length > (this._minPatLen-1) ) {
		    // compute listOptions from templateFilter
		    var allOptions;
		    if( this._template )
			allOptions = this.wiki.filterTiddlers( this._template.filter );
		    else
			allOptions = this.wiki.filterTiddlers("[all[tiddlers]]");
		    this._findBestMatches( allOptions, pattern.text );
    		    displayNode.innerHTML = "";
    		    //console.log( "BC "+ this._pattern + " => " + choice );
    		    if (this._bestMatches.length > 0) {
			for( var i=0; i<this._bestMatches.length; i++) {
    			    displayNode.appendChild( 
				this._itemHTML(this._bestMatches[i], 
					       pattern.text));
    			}
			this._display( areaNode, displayNode );			
    		    }
		    else { // no matches
			this._state = "PATTERN";
			this._undisplay( areaNode, displayNode );
		    }
		}
    	    }
	    else { // no pattern detected
		this._abortPattern( displayNode );
	    }
	}
	// to ensure that one MUST add an input (through onInput())
	this._hasInput = false;
    };
    /**
     * Used for debug
     */
    this._logStatus = function(msg) {
	console.log( "__STATUS: "+this._state+":-"+msg+"- idx="+this._idxChoice );
    };
};

exports.Completion = Completion;

})();
