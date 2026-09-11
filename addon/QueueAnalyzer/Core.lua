-- Core.lua
-- Reads every current applicant to your posted Group Finder listing (you
-- must be the group leader with an active listing that has applicants --
-- this is the Premade Groups applicant queue, not the anonymous automatic
-- Dungeon Finder matchmaking queue, which never exposes names at all).
--
-- C_LFGList.GetApplicants() returns every applicant ID for your listing in
-- one call (confirmed against Blizzard's own LFGListApplicationViewer
-- update code) -- no need to hover or scroll through the UI. The raw order
-- it comes back in does NOT match the on-screen applicant list order
-- (confirmed live) -- Blizzard itself re-sorts it before display via
-- LFGListUtil_SortApplicants (new applications to the bottom, otherwise by
-- applicantInfo.displayOrderID), so we call that exact same function on our
-- own copy before reading names, to match what you see in the window.

BINDING_HEADER_QUEUEANALYZER = "Queue Analyzer"
BINDING_NAME_QUEUEANALYZER_TOGGLE = "Show/export applicant names"

---Collect "Name-Realm" for every member of every current applicant.
---@return string[] names
local function GetApplicantNames()
	local names = {}

	local applicants = C_LFGList.GetApplicants()
	if LFGListUtil_SortApplicants then
		LFGListUtil_SortApplicants(applicants)
	end
	for _, applicantID in ipairs(applicants) do
		local info = C_LFGList.GetApplicantInfo(applicantID)
		if info then
			for memberIdx = 1, info.numMembers do
				local fullName = C_LFGList.GetApplicantMemberInfo(applicantID, memberIdx)
				if fullName then
					local name, realm = strsplit("-", fullName)
					if not realm or realm == "" then
						realm = GetNormalizedRealmName()
					end
					table.insert(names, name .. "-" .. realm)
				end
			end
		end
	end

	return names
end

-- Data imported from the webapp (pasted into the import window below), keyed
-- by the same "Name-Realm" string GetApplicantNames() produces, valued by a
-- {best, rank} table -- rank is 0 when the webapp's Filter wasn't active for
-- that export (nothing to show). Session-only (no SavedVariables) --
-- re-paste after each /reload, matching the export side which is also
-- always re-read live.
QueueAnalyzerImportedData = {}

---Parse the webapp's flat ":"-delimited "Name-Realm:Best:Rank:Name-Realm:Best:Rank:..."
---string (see LookupForm.tsx's toExportString) into a lookup table. Safe to
---split the whole string on ":" since names/realms never contain one. Always
---triplets -- rank is 0, not omitted, when the webapp had no rank for an
---entry, so the stride here never has to guess.
---@param text string
---@return table<string, {best: number, rank: number}>
local function ParseImportText(text)
	local data = {}
	local clean = text:gsub("%s", "") -- strip any incidental whitespace/newlines from pasting
	local tokens = {}
	for token in clean:gmatch("[^:]+") do
		table.insert(tokens, token)
	end
	for i = 1, #tokens - 2, 3 do
		local key = tokens[i]
		local best = tonumber(tokens[i + 1])
		local rank = tonumber(tokens[i + 2])
		if key and best and rank then
			data[key] = { best = best, rank = rank }
		end
	end
	return data
end

-- Percentile color tiers, matching the webapp's percentileColor() exactly
-- (same hex values: orange/purple/blue/green/grey).
local function PercentileColorCode(pct)
	if pct >= 95 then
		return "|cffff8000" -- orange
	elseif pct >= 75 then
		return "|cffa335ee" -- purple
	elseif pct >= 50 then
		return "|cff0070dd" -- blue
	elseif pct >= 25 then
		return "|cff1eff00" -- green
	else
		return "|cff9d9d9d" -- grey
	end
end

---@return {best: number, rank: number}|nil
local function GetImportedData(name, realm)
	return QueueAnalyzerImportedData[name .. "-" .. realm]
end

local REPO_URL = "https://github.com/LaCocoRoco/queue-analyzer"

-- WoW has no concept of a clickable external link (chat hyperlinks only
-- open in-game item/spell/quest panels, never a browser), so this is just
-- a single-line EditBox pre-filled with the URL -- click it to select-all,
-- then Ctrl+C, same copy pattern as the export/import boxes below.
-- Informational only: never fetched or used by the addon itself.
local function AddRepoFooter(f)
	local box = CreateFrame("EditBox", nil, f)
	box:SetSize(280, 14)
	box:SetPoint("BOTTOM", 0, 14)
	box:SetFontObject(GameFontDisableSmall)
	box:SetJustifyH("CENTER")
	box:SetAutoFocus(false)
	box:SetText(REPO_URL)
	box:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
	box:SetScript("OnMouseDown", function(self)
		self:SetFocus()
		self:HighlightText()
	end)
end

local frame

-- One small window instead of two: an Export field (pre-filled, refreshed
-- live from the current applicants) and an Import field (paste the
-- webapp's result back in), both single-line -- the data itself is always
-- one flat ":"-delimited line anyway (see GetApplicantNames/ParseImportText),
-- so a big multi-line scrollable box was never actually needed and only
-- made it fiddly to know where to click to select everything.
local function CreateQueueAnalyzerFrame()
	local f = CreateFrame("Frame", "QueueAnalyzerFrame", UIParent, "BasicFrameTemplateWithInset")
	f:SetSize(380, 160)
	f:SetPoint("CENTER")
	f:SetMovable(true)
	f:EnableMouse(true)
	f:RegisterForDrag("LeftButton")
	f:SetScript("OnDragStart", f.StartMoving)
	f:SetScript("OnDragStop", f.StopMovingOrSizing)
	f:SetClampedToScreen(true)
	tinsert(UISpecialFrames, "QueueAnalyzerFrame") -- Escape closes it

	f.title = f:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
	f.title:SetPoint("LEFT", f.TitleBg, "LEFT", 5, 0)
	f.title:SetText("Queue Analyzer")

	local exportLabel = f:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	exportLabel:SetPoint("TOPLEFT", 16, -34)
	exportLabel:SetWidth(50)
	exportLabel:SetJustifyH("LEFT")
	exportLabel:SetText("Export")

	local exportBox = CreateFrame("EditBox", "QueueAnalyzerExportEditBox", f, "InputBoxTemplate")
	exportBox:SetSize(210, 19)
	exportBox:SetPoint("LEFT", exportLabel, "RIGHT", 4, 0)
	exportBox:SetAutoFocus(false)
	exportBox:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
	-- Clicking back in re-selects everything -- you should never need to
	-- manually drag-select in a field that only ever holds one full value.
	exportBox:SetScript("OnEditFocusGained", function(self) self:HighlightText() end)
	f.exportBox = exportBox

	local refreshButton = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
	refreshButton:SetText("Refresh")
	refreshButton:SetSize(74, 22)
	refreshButton:SetPoint("LEFT", exportBox, "RIGHT", 8, 0)
	refreshButton:SetScript("OnClick", function() QueueAnalyzer_RefreshExport() end)

	local importLabel = f:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	importLabel:SetPoint("TOPLEFT", exportLabel, "BOTTOMLEFT", 0, -32)
	importLabel:SetWidth(50)
	importLabel:SetJustifyH("LEFT")
	importLabel:SetText("Import")

	local importBox = CreateFrame("EditBox", "QueueAnalyzerImportEditBox", f, "InputBoxTemplate")
	importBox:SetSize(210, 19)
	importBox:SetPoint("LEFT", importLabel, "RIGHT", 4, 0)
	importBox:SetAutoFocus(false)
	importBox:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
	-- Auto-select on focus here too -- otherwise a paste without first
	-- clearing old content would insert at the cursor instead of replacing
	-- it, silently corrupting the data.
	importBox:SetScript("OnEditFocusGained", function(self) self:HighlightText() end)
	f.importBox = importBox

	local importButton = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
	importButton:SetText("Import")
	importButton:SetSize(74, 22)
	importButton:SetPoint("LEFT", importBox, "RIGHT", 8, 0)
	importButton:SetScript("OnClick", function()
		local data = ParseImportText(f.importBox:GetText())
		local count = 0
		for _ in pairs(data) do
			count = count + 1
		end
		QueueAnalyzerImportedData = data
		f.status:SetText(count .. " entries imported.")
	end)

	f.status = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	f.status:SetPoint("TOPLEFT", importLabel, "BOTTOMLEFT", 4, -8)
	f.status:SetText("")

	AddRepoFooter(f)

	return f
end

function QueueAnalyzer_RefreshExport()
	if not frame then
		return
	end

	local names = GetApplicantNames()
	-- One flat ":"-delimited string instead of one name per line -- easier
	-- to select/copy reliably as a single line, and the webapp reads it
	-- back the same way (splits on ":"; names/realms never contain ":").
	-- Empty when there are no applicants -- no placeholder text, just an
	-- empty field.
	local text = table.concat(names, ":")

	frame.exportBox:SetText(text)
	-- Order matters: SetFocus() must come before HighlightText() -- the
	-- reverse order (as this used to be) leaves the text visually selected
	-- but not reliably in the EditBox's actual input focus, so Ctrl+C does
	-- nothing until the user manually clicks in and re-selects.
	frame.exportBox:SetFocus()
	frame.exportBox:HighlightText()
end

function QueueAnalyzer_ToggleFrame()
	if not frame then
		frame = CreateQueueAnalyzerFrame()
	end

	if frame:IsShown() then
		frame:Hide()
		return
	end

	frame:Show()
	QueueAnalyzer_RefreshExport()
end

SLASH_QUEUEANALYZER1 = "/qa"
SLASH_QUEUEANALYZER2 = "/queueanalyzer"
SlashCmdList["QUEUEANALYZER"] = QueueAnalyzer_ToggleFrame

-- Right-click entry on individual applicants: right-clicking a member row
-- already opens a Blizzard context menu (Whisper/Report), built with the
-- modern Menu API and tagged "MENU_LFG_FRAME_MEMBER_APPLY" (confirmed
-- against Blizzard's own LFGListApplicantMember_OnMouseDown). Menu.ModifyMenu
-- is Blizzard's sanctioned extension point for exactly this -- no click
-- hijacking, no taint risk. Safe to register immediately; it fires
-- whenever that menu is opened, regardless of load order.
if Menu and Menu.ModifyMenu then
	Menu.ModifyMenu("MENU_LFG_FRAME_MEMBER_APPLY", function(owner, rootDescription)
		rootDescription:CreateDivider()
		rootDescription:CreateButton("Copy all applicants (Queue Analyzer)", QueueAnalyzer_ToggleFrame)
	end)
end

-- Walk up from an applicant-member row's frame looking for the ancestor that
-- carries .applicantID -- Blizzard stores it on the applicant entry frame,
-- one or two levels above the individual member sub-frame the OnEnter fires
-- on, and the exact depth isn't worth hardcoding when a short walk covers
-- it regardless.
local function FindApplicantID(f)
	local current = f
	for _ = 1, 5 do
		if not current then
			return nil
		end
		if current.applicantID then
			return current.applicantID
		end
		current = current.GetParent and current:GetParent()
	end
	return nil
end

-- Appends the imported "Best" value (colored like the webapp's percentile
-- tiers) to the tooltip Blizzard already shows when hovering a member of an
-- applicant in the Application Viewer -- so you can see it while reviewing
-- applicants instead of alt-tabbing to compare against the webapp table.
-- LFGListApplicantMember_OnEnter is defined inside Blizzard_GroupFinder,
-- which is load-on-demand -- same reason AddApplicationViewerButton below
-- waits for ADDON_LOADED instead of hooking at file-load time.
local hookedApplicantTooltip = false
local function HookApplicantTooltip()
	if hookedApplicantTooltip or not LFGListApplicantMember_OnEnter then
		return
	end
	hookedApplicantTooltip = true

	hooksecurefunc("LFGListApplicantMember_OnEnter", function(self)
		local applicantID = FindApplicantID(self)
		local memberIdx = self.memberIdx
		if not applicantID or not memberIdx then
			return
		end

		local fullName = C_LFGList.GetApplicantMemberInfo(applicantID, memberIdx)
		if not fullName then
			return
		end
		local name, realm = strsplit("-", fullName)
		if not realm or realm == "" then
			realm = GetNormalizedRealmName()
		end

		local data = GetImportedData(name, realm)
		if data and GameTooltip:IsOwned(self) then
			GameTooltip:AddLine(" ")
			-- Whole numbers only -- the webapp now exports Best rounded, no
			-- decimals, so "%d" (not "%.1f") avoids a stray ".0" suffix.
			GameTooltip:AddLine("Queue Analyzer Best: " .. PercentileColorCode(data.best) .. string.format("%d", data.best) .. "|r")
			GameTooltip:Show()
		end
	end)
end

-- Prepends "RANK:BEST:" (or just "BEST:" when no rank was exported) to the
-- name shown for each applicant member in the Application Viewer list
-- itself -- unlike the tooltip above, this is visible without hovering.
-- LFGListApplicationViewer_UpdateApplicantMember is what Blizzard's own code
-- calls to (re)paint a member row's Name text every time the list refreshes
-- (scrolling, new applicants, etc.), so this re-fires often -- it rebuilds
-- the display name itself (Ambiguate + the "  " indent Blizzard uses for
-- group members past the first) from scratch every time rather than reading
-- back member.Name's current text, which would already contain our own
-- prefix from the previous call and double up indefinitely otherwise.
local hookedApplicantNamePrefix = false
local function HookApplicantNamePrefix()
	if hookedApplicantNamePrefix or not LFGListApplicationViewer_UpdateApplicantMember then
		return
	end
	hookedApplicantNamePrefix = true

	hooksecurefunc("LFGListApplicationViewer_UpdateApplicantMember", function(member, appID, memberIdx)
		local fullName = C_LFGList.GetApplicantMemberInfo(appID, memberIdx)
		if not fullName then
			return
		end
		local name, realm = strsplit("-", fullName)
		if not realm or realm == "" then
			realm = GetNormalizedRealmName()
		end

		local data = GetImportedData(name, realm)
		if not data then
			return
		end

		local displayName = Ambiguate(fullName, "short")
		if memberIdx > 1 then
			displayName = "  " .. displayName
		end

		local prefix
		if data.rank > 0 then
			prefix = string.format("%02d:%d:", data.rank, data.best)
		else
			prefix = string.format("%d:", data.best)
		end

		member.Name:SetText(PercentileColorCode(data.best) .. prefix .. "|r" .. displayName)
	end)
end

-- Button above the applicant list. LFGListFrame only exists once the
-- Blizzard_GroupFinder addon has loaded (it's load-on-demand), so this
-- waits for that before creating/parenting the button.
local function AddApplicationViewerButton()
	local panel = LFGListFrame.ApplicationViewer
	if not panel or panel.QueueAnalyzerButton then
		return
	end

	local button = CreateFrame("Button", nil, panel, "UIPanelButtonTemplate")
	button:SetSize(90, 20)
	button:SetText("Analyzer")
	-- Far enough left of TOPRIGHT to clear the panel's own close button --
	-- at -6 the two hitboxes overlapped, so the close button (drawn on top)
	-- silently ate the first click instead of it reaching this one.
	button:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -34, -4)
	button:SetScript("OnClick", QueueAnalyzer_ToggleFrame)
	panel.QueueAnalyzerButton = button
end

-- Compact LOG/Rank readout squeezed into the Role column's own leftover
-- space, right after whichever role icon is actually the rightmost visible
-- one (applicants show 1-3 icons depending on which roles they're flexible
-- for) -- anchored to that icon instead of a fixed x-offset so it adapts
-- automatically instead of assuming a fixed icon count. Deliberately no
-- header label and the smallest available font: LFGListFrame can't be
-- resized (both corners are anchored, so SetWidth is a no-op -- confirmed
-- live), so unlike the name prefix, this has zero room to spare.
local function GetLastRoleIcon(member)
	if member.RoleIcon3:IsShown() then
		return member.RoleIcon3
	end
	if member.RoleIcon2:IsShown() then
		return member.RoleIcon2
	end
	return member.RoleIcon1
end

-- Full combo, all four placements at once, to compare side by side live --
-- expected to prune down to whichever ones actually hold up once you've
-- seen them in game:
--   1. Name prefix (HookApplicantNamePrefix) -- unchanged.
--   2. After the last role icon: rank + log combined (unchanged from before).
--   3. After iLvl: rank alone, anchored to member.ItemLevel same way (2) is
--      anchored to the role icon.
--   4. After Rating: log alone, anchored to member.Rating the same way --
--      this is the one most likely to collide with the Accept/Decline
--      buttons (confirmed no free space there in the earlier column
--      experiment), but the ask was to try it, so here it is.
local hookedApplicantReadouts = false
local function HookApplicantReadouts()
	if hookedApplicantReadouts or not LFGListApplicationViewer_UpdateApplicantMember then
		return
	end
	hookedApplicantReadouts = true

	hooksecurefunc("LFGListApplicationViewer_UpdateApplicantMember", function(member, appID, memberIdx)
		local fullName = C_LFGList.GetApplicantMemberInfo(appID, memberIdx)
		if not fullName then
			return
		end
		local name, realm = strsplit("-", fullName)
		if not realm or realm == "" then
			realm = GetNormalizedRealmName()
		end

		local data = GetImportedData(name, realm)

		if not member.QueueAnalyzerRoleReadout then
			member.QueueAnalyzerRoleReadout = member:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
		end
		if not member.QueueAnalyzerIlvlReadout then
			member.QueueAnalyzerIlvlReadout = member:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
		end
		if not member.QueueAnalyzerRatingReadout then
			member.QueueAnalyzerRatingReadout = member:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
		end

		if not data then
			member.QueueAnalyzerRoleReadout:SetText("")
			member.QueueAnalyzerIlvlReadout:SetText("")
			member.QueueAnalyzerRatingReadout:SetText("")
			return
		end

		-- Re-anchored every update (not just on creation) since which role
		-- icon is the rightmost visible one can change between applicants.
		member.QueueAnalyzerRoleReadout:ClearAllPoints()
		member.QueueAnalyzerRoleReadout:SetPoint("LEFT", GetLastRoleIcon(member), "RIGHT", 2, 0)
		local roleText = data.rank > 0 and string.format("%02d %d", data.rank, data.best) or tostring(data.best)
		member.QueueAnalyzerRoleReadout:SetText(PercentileColorCode(data.best) .. roleText .. "|r")

		member.QueueAnalyzerIlvlReadout:ClearAllPoints()
		member.QueueAnalyzerIlvlReadout:SetPoint("LEFT", member.ItemLevel, "RIGHT", 2, 0)
		local rankText = data.rank > 0 and string.format("%02d", data.rank) or ""
		member.QueueAnalyzerIlvlReadout:SetText(PercentileColorCode(data.best) .. rankText .. "|r")

		member.QueueAnalyzerRatingReadout:ClearAllPoints()
		member.QueueAnalyzerRatingReadout:SetPoint("LEFT", member.Rating, "RIGHT", 2, 0)
		member.QueueAnalyzerRatingReadout:SetText(PercentileColorCode(data.best) .. data.best .. "|r")
	end)
end

local function OnGroupFinderLoaded()
	AddApplicationViewerButton()
	HookApplicantTooltip()
	HookApplicantNamePrefix()
	HookApplicantReadouts()
end

local loader = CreateFrame("Frame")
loader:RegisterEvent("ADDON_LOADED")
loader:SetScript("OnEvent", function(_, _, addonName)
	if addonName == "Blizzard_GroupFinder" then
		OnGroupFinderLoaded()
	end
end)

-- Blizzard_GroupFinder may already be loaded by the time we get here
-- (e.g. after a /reload while the group finder was open).
if C_AddOns and C_AddOns.IsAddOnLoaded and C_AddOns.IsAddOnLoaded("Blizzard_GroupFinder") then
	OnGroupFinderLoaded()
end
