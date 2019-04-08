/*\
title: $:/plugins/jlazarow/pdfcomplete/pdfcomplete.js
type: application/javascript
module-type: widget

\*/
(function(){

/*jslint node: true, browser: true */
/*global $tw: false */
"use strict";

var completePDFWidgetFactory = require("$:/core/modules/editor/factory.js").editTextWidgetFactory,
	FramedCompEngine = require("$:/plugins/jlazarow/pdfcomplete/framed.js").FramedCompEngine,
	SimpleCompEngine = require("$:/plugins/jlazarow/pdfcomplete/simple.js").SimpleCompEngine;

exports["edit-completepdf"] = completePDFWidgetFactory(FramedCompEngine, SimpleCompEngine);

})();
