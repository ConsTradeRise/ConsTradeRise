// Vercel Speed Insights initialization
// This script initializes Speed Insights tracking for the application
// Based on the official Vercel Speed Insights implementation

(function() {
  'use strict';
  
  // Initialize the queue for Speed Insights
  if (window.si) return;
  
  window.si = window.si || function() {
    (window.siq = window.siq || []).push(arguments);
  };
  
  // Inject the Speed Insights script
  var script = document.createElement('script');
  script.defer = true;
  script.src = '/_vercel/speed-insights/script.js';
  script.dataset.sdkn = '@vercel/speed-insights';
  script.dataset.sdkv = '2.0.0';
  
  script.onerror = function() {
    console.log('[Vercel Speed Insights] Failed to load script. Please check if any content blockers are enabled and try again.');
  };
  
  document.head.appendChild(script);
})();
