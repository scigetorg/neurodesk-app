// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { WebContentsView } from 'electron';
import { DarkThemeBGColor, LightThemeBGColor } from '../utils';
import * as path from 'path';
import * as fs from 'fs';
import { EventTypeRenderer } from '../eventtypes';
import { getContainerCatalog } from '../config/catalogInstance';
import { IMiniApp, toInlineScriptJson, toMiniApps } from './miniapps';

function catalogMiniApps(): IMiniApp[] {
  const catalog = getContainerCatalog();
  return toMiniApps(
    catalog.getIds().map(id => ({ id, entry: catalog.getEntry(id) }))
  );
}

export class WelcomeView {
  constructor(options: WelcomeView.IOptions) {
    this._isDarkTheme = options.isDarkTheme;
    this._view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, './preload.js'),
        devTools: process.env.NODE_ENV === 'development'
      }
    });

    this._view.setBackgroundColor(
      this._isDarkTheme ? DarkThemeBGColor : LightThemeBGColor
    );

    const scigetLogo = fs.readFileSync(
      path.join(__dirname, '../../../app-assets/sciget.svg')
    );

    // The catalog as it is now (cache or bundled); load() pushes the
    // refreshed one when the network fetch completes.
    this._miniApps = catalogMiniApps();
    const miniAppsJson = toInlineScriptJson(this._miniApps);

    this._pageSource = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0">
          <title>Welcome</title>
          <style>
            * {
              margin: 0;
              padding: 0;
              box-sizing: border-box;
            }

            body {
              background: ${LightThemeBGColor};
              color: #000000;
              margin: 0;
              overflow-x: hidden;
              overflow-y: auto;
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica,
                Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji',
                'Segoe UI Symbol';
              font-size: 13px;
              -webkit-user-select: none;
              user-select: none;
              min-height: 100vh;
              padding: 20px;
            }

            body.app-ui-dark {
              background: ${DarkThemeBGColor};
              color: #ffffff;
            }

            .container {
                max-width: 1200px;
                margin: 0 auto;
            }

            .header {
                text-align: center;
                margin-bottom: 40px;
                color: #1f2937;
            }

            .app-ui-dark .header {
                color: #e5e7eb;
            }

            .header h1 {
                font-size: 2.5rem;
                margin-bottom: 10px;
                font-weight: 700;
            }

            .header p {
                font-size: 1.1rem;
                opacity: 0.9;
            }

            .apps-grid {
              display: grid;
              grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
              gap: 24px;
              margin-bottom: 40px;
          }

          .app-card {
              background: white;
              border-radius: 4px;
              padding: 24px;
              box-shadow: 0 10px 30px rgba(0, 0, 0, 0.1);
              transition: all 0.3s ease;
              position: relative;
          }

          .app-ui-dark .app-card {
              background: #4f4f4f;
              box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
          }

          .app-card:hover {
              box-shadow: 0 20px 40px rgba(0, 0, 0, 0.15);
          }

          .app-ui-dark .app-card:hover {
              box-shadow: 0 20px 40px rgba(66, 66, 66, 0.4);
          }

          .app-title {
              font-size: 1.4rem;
              font-weight: 600;
              margin-bottom: 8px;
              color: #2d3748;
          }

          .app-ui-dark .app-title {
              color: #e2e8f0;
          }

          .app-description {
              color: #718096;
              margin-bottom: 16px;
              line-height: 1.5;
          }

          .app-ui-dark .app-description {
              color: #a0aec0;
          }

          .app-logo-row {
            display: flex;
            align-items: center;
            justify-content: center;
            column-gap: 10px;
          }
          
          .app-logo {
            font-size: 30px;
          }

          .sciget-logo svg {
            height: 120px;
          }

          .sciget-logo {
            color: #0c0e0a;
          }

          .app-ui-dark .sciget-logo {
            color: #ffffff;
          }

          .announcement-card {
            border-top: 4px solid #6aa329;
          }

          .app-ui-dark .announcement-card {
            border-top-color: #b7d886;
          }

          .announcement-header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 16px;
          }

          .announcement-heading .app-title {
            margin-bottom: 0;
          }

          .announcement-label {
            display: inline-block;
            margin-bottom: 4px;
            color: #4f7d23;
            font-size: 0.72rem;
            font-weight: 700;
            letter-spacing: 0.08em;
            text-transform: uppercase;
          }

          .app-ui-dark .announcement-label {
            color: #c8e6a6;
          }

          .launch-buttons {
              display: flex;
              gap: 12px;
          }

          .launch-btn {
              flex: 1;
              padding: 12px 16px;
              border: none;
              border-radius: 4px;
              font-weight: 600;
              cursor: pointer;
              transition: all 0.2s ease;
              font-size: 0.9rem;
              position: relative;
              overflow: hidden;
            }

            .launch-btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }

            .remote-btn {
                background:rgb(201, 201, 201);
                color: black;
            }

            .remote-btn:hover:not(:disabled) {
                background:rgb(103, 102, 102);
                color: white;
            }

            .local-btn {
                background: #6aa329;
                color: white;
            }

            .local-btn:hover:not(:disabled) {
                background: #b7d886;
            }

            .launch-btn.loading {
                pointer-events: none;
            }

            .launch-btn.loading::after {
                content: '';
                position: absolute;
                top: 50%;
                left: 50%;
                width: 16px;
                height: 16px;
                margin: -8px 0 0 -8px;
                border: 2px solid transparent;
                border-top: 2px solid currentColor;
                border-radius: 50%;
                animation: spin 1s linear infinite;
            }

            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }

            /* Split button */
            .split-btn-wrapper {
                flex: 1;
                display: flex;
                position: relative;
            }

            .split-btn-main {
                flex: 1;
                padding: 12px 16px;
                border: none;
                border-radius: 4px 0 0 4px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s ease;
                font-size: 0.9rem;
                background: #b7d886;
                color: black;
            }

            .split-btn-main:hover {
                background: #6aa329;
                color: white;
            }

            .split-btn-arrow {
                padding: 12px 10px;
                border: none;
                border-left: 1px solid rgba(0, 0, 0, 0.15);
                border-radius: 0 4px 4px 0;
                font-size: 0.7rem;
                cursor: pointer;
                transition: all 0.2s ease;
                background: #b7d886;
                color: black;
            }

            .split-btn-arrow:hover {
                background: #6aa329;
                color: white;
            }

            .version-dropdown {
                display: none;
                position: absolute;
                top: 100%;
                left: 0;
                right: 0;
                margin-top: 4px;
                background: white;
                border-radius: 4px;
                box-shadow: 0 8px 25px rgba(0, 0, 0, 0.15);
                z-index: 100;
                max-height: 250px;
                overflow-y: auto;
            }

            .app-ui-dark .version-dropdown {
                background: #2d2d2d;
                box-shadow: 0 8px 25px rgba(0, 0, 0, 0.4);
            }

            .version-dropdown.open {
                display: block;
            }

            .version-dropdown-item {
                padding: 8px 14px;
                cursor: pointer;
                font-size: 0.85rem;
                color: #2d3748;
                transition: background 0.15s;
            }

            .app-ui-dark .version-dropdown-item {
                color: #e2e8f0;
            }

            .version-dropdown-item:first-child {
                border-radius: 4px 4px 0 0;
            }

            .version-dropdown-item:hover {
                background: rgba(66, 153, 225, 0.1);
            }

            .version-dropdown-item.latest-tag {
                font-weight: 600;
            }

            .version-dropdown-loading {
                padding: 12px 14px;
                font-size: 0.85rem;
                color: #718096;
                text-align: center;
            }

            .version-dropdown-custom {
                padding: 8px 10px;
                border-top: 1px solid rgba(0, 0, 0, 0.1);
            }

            .app-ui-dark .version-dropdown-custom {
                border-top-color: rgba(255, 255, 255, 0.1);
            }

            .version-dropdown-custom input {
                width: 100%;
                padding: 6px 10px;
                border: 1px solid #cbd5e0;
                border-radius: 4px;
                font-size: 0.85rem;
                background: transparent;
                color: inherit;
                box-sizing: border-box;
            }

            .app-ui-dark .version-dropdown-custom input {
                border-color: #4a5568;
            }

            .version-dropdown-custom input::placeholder {
                color: #a0aec0;
            }

            .version-dropdown-custom input:focus {
                outline: none;
                border-color: #4299e1;
            }

            @media (max-width: 768px) {
                .apps-grid {
                    grid-template-columns: 1fr;
                }

                .header h1 {
                    font-size: 2rem;
                }

                .launch-buttons {
                    flex-direction: column;
                }
            }

            .search-container {
                position: relative;
                max-width: 500px;
                margin: 0 auto 40px auto;
            }

            .search-input {
                width: 100%;
                padding: 16px 50px 16px 20px;
                border: none;
                border-radius: 4px;
                background: rgba(255, 255, 255, 0.95);
                backdrop-filter: blur(10px);
                font-size: 1rem;
                color: #2d3748;
                box-shadow: 0 8px 25px rgba(0, 0, 0, 0.1);
                transition: all 0.3s ease;
            }

            .app-ui-dark .search-input {
                background: rgba(81, 81, 81, 0.95);
                color: #e2e8f0;
                box-shadow: 0 8px 25px rgba(0, 0, 0, 0.3);
            }

            .search-input:focus {
                outline: none;
                background: white;
                box-shadow: 0 12px 35px rgba(0, 0, 0, 0.15);
            }

            .app-ui-dark .search-input:focus {
                background: #2d2d2d;
                box-shadow: 0 12px 35px rgba(0, 0, 0, 0.4);
            }

            .search-input::placeholder {
                color: #a0aec0;
            }

            .search-icon {
                position: absolute;
                right: 16px;
                top: 50%;
                transform: translateY(-50%);
                font-size: 18px;
                color: #a0aec0;
                pointer-events: none;
            }

            #notification-panel {
              position: sticky;
              bottom: 0;
              display: none;
              height: 50px;
              padding: 0 20px;
              background: inherit;
              border-top: 1px solid #585858;
              align-items: center;
            }
            #notification-panel-message {
              flex-grow: 1;
              display: flex;
              align-items: center;
            }
            #notification-panel-message a {
              margin: 0 4px;
            }
            #notification-panel .close-button {
              width: 20px;
              height: 20px;
              fill: #555555;
              cursor: pointer;
            }
            .app-ui-dark #notification-panel .close-button {
              fill: #bcbcbc;
            }
            #survey-reminder {
              position: fixed;
              bottom: 24px;
              right: 24px;
              width: 280px;
              background: white;
              border-radius: 4px;
              box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
              padding: 16px;
              z-index: 1000;
              display: none;
            }
            .app-ui-dark #survey-reminder {
              background: #4f4f4f;
              box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
            }
            #survey-reminder-header {
              display: flex;
              justify-content: space-between;
              align-items: flex-start;
              margin-bottom: 8px;
            }
            #survey-reminder-title {
              font-weight: 600;
              font-size: 0.9rem;
              color: #2d3748;
            }
            .app-ui-dark #survey-reminder-title {
              color: #e2e8f0;
            }
            #survey-reminder-close {
              cursor: pointer;
              width: 16px;
              height: 16px;
              fill: #a0aec0;
              flex-shrink: 0;
              margin-left: 8px;
              margin-top: 1px;
            }
            #survey-reminder-close:hover {
              fill: #718096;
            }
            .app-ui-dark #survey-reminder-close:hover {
              fill: #e2e8f0;
            }
            .scroll-box {
              max-height: 150px;
              overflow-y: auto;
              margin-bottom: 12px;
            }
            #survey-reminder-desc {
              font-size: 0.72rem;
              color: #718096;
              margin-bottom: 12px;
              line-height: 1.4;
            }
            #survey-reminder-desc-small {
              font-size: 0.62rem;
              color: #718096;
              margin-bottom: 12px;
              line-height: 1.4;
            }
            .app-ui-dark #survey-reminder-desc {
              color: #a0aec0;
            }
            #survey-reminder-btn {
              display: inline-block;
              padding: 8px 16px;
              background: #b7d886;
              color: black;
              font-weight: 600;
              font-size: 0.85rem;
              border-radius: 4px;
              cursor: pointer;
              border: none;
              transition: background 0.2s ease;
            }
            #survey-reminder-btn:hover {
              background: #6aa329;
            }
          </style>
          <script>
            document.addEventListener("DOMContentLoaded", () => {
              const platform = "${process.platform}";
              document.body.dataset.appPlatform = platform;
              document.body.classList.add('app-ui-' + platform);
            });
          </script>
        </head>

        <body class="${this._isDarkTheme ? 'app-ui-dark' : ''} title="">
          <svg class="symbol" style="display: none;">
          <defs>
            <symbol id="circle-xmark" viewBox="0 0 512 512">
              <!--! Font Awesome Pro 6.2.1 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license (Commercial License) Copyright 2022 Fonticons, Inc. --><path d="M256 512c141.4 0 256-114.6 256-256S397.4 0 256 0S0 114.6 0 256S114.6 512 256 512zM175 175c9.4-9.4 24.6-9.4 33.9 0l47 47 47-47c9.4-9.4 24.6-9.4 33.9 0s9.4 24.6 0 33.9l-47 47 47 47c9.4 9.4 9.4 24.6 0 33.9s-24.6 9.4-33.9 0l-47-47-47 47c-9.4 9.4-24.6 9.4-33.9 0s-9.4-24.6 0-33.9l47-47-47-47c-9.4-9.4-9.4-24.6 0-33.9z"/>
            </symbol>
            <symbol id="triangle-exclamation" viewBox="0 0 512 512">
              <!--! Font Awesome Pro 6.2.1 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license (Commercial License) Copyright 2022 Fonticons, Inc. --><path d="M256 32c14.2 0 27.3 7.5 34.5 19.8l216 368c7.3 12.4 7.3 27.7 .2 40.1S486.3 480 472 480H40c-14.3 0-27.6-7.7-34.7-20.1s-7-27.8 .2-40.1l216-368C228.7 39.5 241.8 32 256 32zm0 128c-13.3 0-24 10.7-24 24V296c0 13.3 10.7 24 24 24s24-10.7 24-24V184c0-13.3-10.7-24-24-24zm32 224c0-17.7-14.3-32-32-32s-32 14.3-32 32s14.3 32 32 32s32-14.3 32-32z"/></svg>
            </symbol>
          </defs>
          </svg>
          <div class="container">
            <div class="row app-logo-row">
              <div class="app-logo">
                <div class="sciget-logo">
                    ${scigetLogo}
                </div>
              </div>
            </div>

              <div class="search-container">
                  <input type="text" id="searchInput" placeholder="Search apps..." class="search-input">
                  <div class="search-icon">&#128269;</div>
              </div>

              <div class="apps-grid" id="appsGrid">
                  <!-- Apps will be dynamically generated here -->
              </div>
          </div>
          <div id="notification-panel">
            <div id="notification-panel-message">
            </div>
            <div id="notification-panel-close" title="Close" onclick="closeNotificationPanel(event)">
              <svg class="close-button" version="2.0">
                <use href="#circle-xmark" />
              </svg>
            </div>
          </div>

          <div id="survey-reminder">
            <div id="survey-reminder-header">
              <span id="survey-reminder-title">Help us understand user needs</span>
              <svg id="survey-reminder-close" onclick="this.parentElement.parentElement.style.display = 'none';" viewBox="0 0 512 512" title="Dismiss">
                <use href="#circle-xmark" />
              </svg>
            </div>
            <div class="scroll-box">
            <p id="survey-reminder-desc">The Neurodesk team is conducting a voluntary online survey lasting approximately 15 minutes, or up to 25 minutes if you use more than one of the platforms, about experiences with Neurodesk, NeurodeskEDU and/or Sciget, priorities for future features, and views about possible future collection of platform usage data.</p>
            <p id="survey-reminder-desc-small">The research survey does not collect usage logs. Most questions use rating scales or multiple-choice responses. No compensation is offered, and taking part will not affect your access or support. Read the study information and decide whether to participate in the survey.</p>
            </div>
            <button id="survey-reminder-btn" onclick="openSurveyLink()">Participate</button>
          </div>

          <script>

          const notificationPanel = document.getElementById('notification-panel');
          const notificationPanelMessage = document.getElementById('notification-panel-message');
          const notificationPanelCloseButton = document.getElementById('notification-panel-close');

          // Container catalog entries; replaced by onSetMiniApps after a refresh.
          let miniApps = ${miniAppsJson};

          // Function to filter apps based on search term
          function filterApps(searchTerm) {
            if (!searchTerm.trim()) {
                return miniApps;
            }

            const term = searchTerm.toLowerCase();
            return miniApps.filter(app =>
                app.title.toLowerCase().includes(term) ||
                app.description.toLowerCase().includes(term)
            );
          }

          function el(tag, className, text) {
            const node = document.createElement(tag);
            if (className) node.className = className;
            if (text !== undefined) node.textContent = text;
            return node;
          }

          // Cards are built with DOM calls, never HTML strings: titles,
          // descriptions and URLs come from the remotely hosted catalog.
          function createAppCard(app) {
              const card = el('div', 'app-card');
              card.append(
                  el('h3', 'app-title', app.title),
                  el('p', 'app-description', app.description)
              );
              const buttons = el('div', 'launch-buttons');
              buttons.append(createLocalButton(app));
              if (app.remoteUrl && app.remoteUrl.length > 0) {
                  const remote = el('button', 'launch-btn remote-btn', 'Launch Remote');
                  remote.addEventListener('click', () => handleNewRemoteSessionClick(app));
                  buttons.append(remote);
              }
              card.append(buttons);
              return card;
          }

          function createLocalButton(app) {
              if (!app.releaseHistoryUrl) {
                  const button = el('button', 'launch-btn local-btn', 'Launch Local');
                  button.addEventListener('click', () => handleNewSessionClick(app, null));
                  return button;
              }
              const wrapper = el('div', 'split-btn-wrapper');
              const main = el('button', 'split-btn-main', 'Launch Local');
              const arrow = el('button', 'split-btn-arrow', '\\u25BC');
              const dropdown = el('div', 'version-dropdown');
              main.addEventListener('click', () => launchLatestVersion(app, main));
              arrow.addEventListener('click', event => toggleVersionDropdown(event, app, dropdown));
              wrapper.append(main, arrow, dropdown);
              return wrapper;
          }

          // Function to render all apps (updated to handle filtering)
          function renderApps(filteredApps = miniApps) {
              const appsGrid = document.getElementById('appsGrid');
              const searchTerm = document.getElementById('searchInput').value.trim().toLowerCase();
              const announcementText = 'coming next sciget next version neurodesk app scientific work';
              const showAnnouncement = !searchTerm || announcementText.includes(searchTerm);

              if (filteredApps.length === 0 && !showAnnouncement) {
                  appsGrid.innerHTML = \`
                      <div style="grid-column: 1 / -1; text-align: center; padding: 40px;">
                          <h3 style="margin-bottom: 8px;">No apps found</h3>
                          <p style="opacity: 0.8;">Try adjusting your search terms</p>
                      </div>
                  \`;
                  return;
              }


              appsGrid.replaceChildren(...filteredApps.map(createAppCard));
              // Static markup from the bundled page, not catalog data.
              appsGrid.insertAdjacentHTML('beforeend', announcementHTML);
          }

          // Add search functionality
          const searchInput = document.getElementById('searchInput');
          searchInput.addEventListener('input', (e) => {
              const searchTerm = e.target.value;
              const filteredApps = filterApps(searchTerm);
              renderApps(filteredApps);
          });

          window.electronAPI.onSetMiniApps(list => {
              miniApps = list;
              renderApps(filterApps(searchInput.value));
          });

          // Initialize the app
          document.addEventListener('DOMContentLoaded', () => {
              renderApps();
          });

          document.addEventListener('dragover', (event) => {
            event.preventDefault();
            event.stopPropagation();
          });

          document.addEventListener('drop', (event) => {
            event.preventDefault();
            event.stopPropagation();

            const files = [];
            for (const file of event.dataTransfer.files) {
              files.push(file.path);
            }

            window.electronAPI.openDroppedFiles(files);
          });

          function handleNewSessionClick(app, imageVersion) {
            window.electronAPI.newSession('notebook', app.id, undefined, imageVersion || undefined, app.telemetryId);
          }

          async function launchLatestVersion(app, button) {
            button.disabled = true;
            button.textContent = 'Checking latest version...';

            try {
              const versions = await window.electronAPI.fetchReleases(
                app.releaseHistoryUrl,
                app.defaultVersion
              );
              handleNewSessionClick(app, versions[0] || app.defaultVersion);
            } catch (err) {
              console.error('Failed to load release history:', err);
              handleNewSessionClick(app, app.defaultVersion);
            } finally {
              button.disabled = false;
              button.textContent = 'Launch Local';
            }
          }

          function handleNewRemoteSessionClick(app) {
            window.electronAPI.newSession('remote', undefined, app.remoteUrl, undefined, app.telemetryId);
          }

          function closeDropdowns() {
            document.querySelectorAll('.version-dropdown.open').forEach(dd => {
              dd.classList.remove('open');
            });
          }

          // Close any open dropdown when clicking outside
          document.addEventListener('click', (e) => {
            document.querySelectorAll('.version-dropdown.open').forEach(dd => {
              if (!dd.parentElement.contains(e.target)) {
                dd.classList.remove('open');
              }
            });
          });

          async function toggleVersionDropdown(event, app, dropdown) {
            event.stopPropagation();

            if (dropdown.classList.contains('open')) {
              dropdown.classList.remove('open');
              return;
            }
            closeDropdowns();
            dropdown.classList.add('open');

            if (dropdown.dataset.loaded === 'true') {
              return;
            }
            dropdown.replaceChildren(el('div', 'version-dropdown-loading', 'Loading versions...'));
            try {
              const versions = await window.electronAPI.fetchReleases(
                app.releaseHistoryUrl,
                app.defaultVersion
              );
              renderDropdownItems(dropdown, versions, app);
              dropdown.dataset.loaded = 'true';
            } catch (err) {
              dropdown.replaceChildren(el('div', 'version-dropdown-loading', 'Failed to load versions'));
            }
          }

          function renderDropdownItems(dropdown, versions, app) {
            const items = versions.map((version, i) => {
              const item = el(
                'div',
                i === 0 ? 'version-dropdown-item latest-tag' : 'version-dropdown-item',
                i === 0 ? version + ' (Latest)' : version
              );
              item.addEventListener('click', () => {
                closeDropdowns();
                handleNewSessionClick(app, version);
              });
              return item;
            });

            // Custom tag input
            const custom = el('div', 'version-dropdown-custom');
            const input = el('input');
            input.type = 'text';
            input.placeholder = 'Custom tag (e.g. pre-release)';
            input.addEventListener('keydown', event => {
              if (event.key !== 'Enter') return;
              const tag = input.value.trim();
              if (tag) {
                closeDropdowns();
                handleNewSessionClick(app, tag);
              }
            });
            custom.append(input);

            dropdown.replaceChildren(...items, custom);
          }

          function sendMessageToMain(message, ...args) {
            window.electronAPI.sendMessageToMain(message, ...args);
          }

          function showNotificationPanel(message, closable) {
            notificationPanelMessage.innerHTML = message;
            notificationPanel.style.display = "flex";
            notificationPanelCloseButton.style.display = closable ? 'block' : 'none';
          }

          function closeNotificationPanel() {
            notificationPanel.style.display = "none";
          }

          window.electronAPI.onSetNotificationMessage((message, closable) => {
            showNotificationPanel(message, closable);
          });

          // Survey reminder: visible Oct 1 – Dec 1, 2026 (two-month window)
          const SURVEY_URL = 'https://uniofqueensland.au1.qualtrics.com/jfe/form/SV_1MvJiHaCQZ4I0Tk';
          const SURVEY_START = new Date('2026-10-01');
          const SURVEY_END = new Date('2027-03-15');

          function initSurveyReminder() {
            const now = new Date();
            if (now < SURVEY_START || now > SURVEY_END) return;
            document.getElementById('survey-reminder').style.display = 'block';
          }

          function openSurveyLink() {
            window.electronAPI.openNewsLink(SURVEY_URL);
          }

          document.addEventListener('DOMContentLoaded', initSurveyReminder);

          </script>
        </body>
      </html>
      `;
  }

  get view(): WebContentsView {
    return this._view;
  }

  load() {
    this._view.webContents.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(this._pageSource)}`
    );

    this._viewReady = new Promise<void>(resolve => {
      this._view.webContents.on('dom-ready', () => {
        resolve();
      });
    });

    // Show the refreshed catalog once the fetch (shared with any other
    // caller) finishes, if it changed what the page was built with.
    void getContainerCatalog()
      .refresh()
      .then(() => this._viewReady)
      .then(() => {
        const miniApps = catalogMiniApps();
        if (JSON.stringify(miniApps) === JSON.stringify(this._miniApps)) {
          return;
        }
        this._miniApps = miniApps;
        if (!this._view.webContents.isDestroyed()) {
          this._view.webContents.send(EventTypeRenderer.SetMiniApps, miniApps);
        }
      });
  }

  showNotification(message: string, closable: boolean) {
    this._viewReady.then(() => {
      this._view.webContents.send(
        EventTypeRenderer.SetNotificationMessage,
        message,
        closable
      );
    });
  }

  private _isDarkTheme: boolean;
  private _view: WebContentsView;
  private _viewReady: Promise<void>;
  private _pageSource: string;
  private _miniApps: IMiniApp[];
}

export namespace WelcomeView {
  export interface IOptions {
    isDarkTheme: boolean;
  }
}
