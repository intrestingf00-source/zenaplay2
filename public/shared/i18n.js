/**
 * Shared English / Amharic dictionary + DOM translation helpers.
 * Language is saved per device in localStorage and can be switched from any page.
 */
(function () {
  'use strict';

  const DICT = {
    en: {
      /* ---------------- shared ---------------- */
      'common.etb': 'ETB',
      'lang.label': 'አማርኛ',

      /* ---------------- game ---------------- */
      'nav.play': 'PLAY',
      'nav.board': 'BOARD',
      'nav.me': 'ME',
      'brand.name': 'TIME BOMB',
      'brand.tagline': 'last depositor wins',

      'status.live': 'LIVE',
      'status.paused': 'PAUSED',
      'status.settled': 'SETTLED',
      'status.cancelled': 'CANCELLED',
      'status.arming': 'ARMING…',
      'status.idle': 'IDLE',
      'status.reconnecting': 'RECONNECTING',
      'chip.inRound': 'IN THE ROUND',
      'chip.round': 'ROUND',

      'timer.fuse': 'fuse',
      'timer.sec': 'SEC',
      'timer.seconds': 'SECONDS',
      'pot.label': 'THE POT',

      'last.none': 'No one has pushed in yet — be first',
      'last.lastIn': 'Last in:',
      'last.wouldWin': 'would win {amount} ETB',
      'last.won': '{name} took {amount} ETB',
      'last.cancelled': 'Round cancelled — all pushes refunded',
      'last.paused': 'Game paused by admin',

      'btn.push': 'PUSH IN <b>{fee}</b> ETB',
      'btn.openTelegram': 'OPEN IN TELEGRAM',
      'btn.sub': 'resets the fuse to {sec}s · winner takes {pct}%',

      'hint.default':
        'Every push adds to the pot and puts your name on it. When the fuse dies, the last name on the pot wins.',
      'hint.telegramOnly':
        'Open TIME BOMB from its Telegram bot to play — your Telegram profile is your account.',
      'hint.paused': 'Admin paused the game — hold tight.',
      'hint.waiting': 'Waiting for the next bomb to arm…',
      'hint.needFunds': 'You need {fee} ETB to push in. Ask the admin to credit your wallet.',

      'feed.title': 'Live pushes',
      'feed.empty': 'Waiting for the first push…',
      'feed.waiting': 'Waiting for a round to start…',
      'feed.countOne': '{n} push',
      'feed.countMany': '{n} pushes',

      'time.justNow': 'just now',
      'time.secAgo': '{n}s ago',
      'time.minAgo': '{n}m ago',
      'time.hourAgo': '{n}h ago',

      'board.house': 'House earned',
      'board.paid': 'Paid to winners',
      'board.rounds': 'Bombs played',
      'board.maxPot': 'Biggest pot',
      'board.topWinners': 'Top winners',
      'board.recent': 'Recent bombs',
      'board.noWinners': 'No winners yet — be the first.',
      'board.noRounds': 'Round history will show up here.',
      'board.winOne': '{n} win',
      'board.winMany': '{n} wins',
      'board.noWinner': 'No winner',
      'board.cancelled': 'Cancelled',

      'me.wallet': 'Wallet',
      'me.wins': 'Wins',
      'me.winnings': 'Winnings',
      'me.pushes': 'Pushes',
      'me.guest': 'Guest',
      'me.notInTelegram': 'Open from Telegram to play',
      'me.walletLine': 'Wallet {amount} ETB',
      'me.telegramId': 'Telegram ID {id}',
      'me.rulesTitle': 'How the bomb works',
      'me.rules1': 'The fuse starts at 30 seconds. Every push resets it.',
      'me.rules2': 'Each push costs the fixed entry fee and grows the pot.',
      'me.rules3': 'When the fuse hits 00:00 nobody can push anymore.',
      'me.rules4': 'The last depositor takes 90% of the pot. The house keeps 10%.',
      'me.rules5': 'The winner is paid into their wallet the instant the fuse dies.',
      'me.footnote':
        'Play money only. Wallets are topped up by the admin until a payment provider is connected.',

      'winner.label': 'FUSE BURNED OUT',
      'winner.took': 'was the last one in and takes',
      'winner.cut': 'pot {pot} · house cut {cut}',
      'winner.next': 'Next bomb in <b>{n}</b>s…',
      'winner.arming': 'Next bomb is arming…',

      'toast.push': 'Pushed in! Fuse reset to {sec}s — you hold the pot',
      'toast.noFunds': 'Not enough ETB in your wallet',
      'toast.cancelled': 'Round cancelled — all pushes refunded',
      'toast.muted': 'Fuse sound off',
      'toast.unmuted': 'Fuse sound on',

      /* ---------------- server errors ---------------- */
      'err.round_not_live': 'There is no live round right now',
      'err.paused': 'Game is paused by the admin',
      'err.spam': 'Slow down — give the button a second',
      'err.insufficient_funds': 'Not enough ETB in your wallet',
      'err.banned': 'This account is suspended',
      'err.signed_out': 'Please sign in to continue',
      'err.account_missing': 'Account not found',
      'err.telegram_only': 'Open this game inside Telegram to play',
      'err.telegram_invalid': 'Telegram sign-in failed — reopen the game from Telegram',
      'err.too_many': 'Too many attempts, wait a few minutes',
      'err.no_round': 'No live round right now',
      'err.round_live': 'A round is already live',
      'err.positive_amount': 'Enter a positive amount',
      'err.too_large': 'Amount too large',
      'err.player_not_found': 'Player not found',
      'err.wrong_admin': 'Wrong admin password',
      'err.server': 'Server error, try again',

      /* ---------------- admin ---------------- */
      'admin.brand': 'CONTROL ROOM',
      'admin.sub': 'Time Bomb admin',
      'admin.gameLink': 'Game ↗',
      'admin.exit': 'Exit',
      'admin.loginTitle': 'TIME BOMB',
      'admin.loginSub': 'Admin control room',
      'admin.password': 'Admin password',
      'admin.unlock': 'UNLOCK PANEL',
      'admin.db': 'db: {mode}',
      'admin.expired': 'Session expired — sign in again',

      'stats.house': 'House earned',
      'stats.paid': 'Paid to winners',
      'stats.rounds': 'Bombs played',
      'stats.players': 'Players',

      'live.title': 'Live control',
      'live.round': 'round #{no}',
      'live.noRound': 'no round',
      'live.fuse': 'fuse',
      'live.pot': 'Pot',
      'live.last': 'Last depositor',
      'live.pushes': 'Pushes this round',
      'live.players': 'Players in round',
      'live.pause': 'Pause game',
      'live.resume': 'Resume game',
      'live.end': 'End round now',
      'live.cancel': 'Cancel & refund',
      'live.start': 'Start new round',
      'live.hint':
        '“End round now” pays the current last depositor 90% instantly. “Cancel & refund” returns every push in the round and pays nobody.',

      'set.title': 'Game settings',
      'set.entryFee': 'Entry fee (ETB)',
      'set.houseCut': 'House cut (%)',
      'set.startSeconds': 'Starting fuse (sec)',
      'set.resetSeconds': 'Fuse after a push (sec)',
      'set.startingBalance': 'New player wallet (ETB)',
      'set.gap': 'Anti-spam gap (ms)',
      'set.autoStart': 'Auto-start the next bomb after each one',
      'set.save': 'SAVE SETTINGS',
      'set.saving': 'SAVING…',
      'set.hint': 'Changes apply live. A new entry fee / fuse length is used for the current round too.',
      'set.saved': 'saved {time}',

      'players.title': 'Players',
      'players.search': 'Search name or Telegram ID…',
      'players.player': 'Player',
      'players.wallet': 'Wallet',
      'players.wins': 'Wins',
      'players.actions': 'Actions',
      'players.empty': 'No players yet',
      'players.hint':
        'Deposit or withdraw ETB from any wallet. Withdrawals cannot take a wallet below zero.',
      'players.deposit': 'Deposit',
      'players.withdraw': 'Withdraw',
      'players.noPhone': 'no Telegram ID',
      'players.banned': 'banned',
      'players.ban': 'Ban',
      'players.unban': 'Unban',

      'rounds.title': 'Recent rounds',
      'rounds.no': '#',
      'rounds.winner': 'Winner',
      'rounds.pot': 'Pot',
      'rounds.payout': 'Payout',
      'rounds.house': 'House',
      'rounds.state': 'State',
      'rounds.empty': 'No rounds yet',
      'rounds.inProgress': 'in progress',
      'rounds.none': '—',

      'modal.title': 'Player wallet',
      'modal.sub': 'Wallet {amount} ETB — amount to adjust',
      'modal.credit': 'DEPOSIT',
      'modal.debit': 'WITHDRAW',

      'at.paused': 'Game paused — fuse frozen',
      'at.resumed': 'Game resumed',
      'at.roundSettled': 'Round settled',
      'at.newRound': 'New bomb armed',
      'at.settingsSaved': 'Settings saved',
      'at.positiveAmount': 'Enter a positive amount',
      'at.autoOn': 'Auto-start on',
      'at.autoOff': 'Auto-start off — start rounds manually',
      'at.credited': 'Deposited {amount} ETB to {name}',
      'at.debited': 'Withdrew {amount} ETB from {name}',
      'at.banned': 'Banned {name}',
      'at.unbanned': 'Unbanned {name}',
      'at.deposit': '{name} pushed {amount} ETB',
      'at.paid': 'Paid {name} {amount} ETB',
      'at.recycled': 'Round had no pot — recycled',
      'at.refunded': 'Round cancelled — {amount} ETB refunded',
      'at.nothingRefund': 'Nothing to refund',
      'at.sessionExpired': 'Session expired — sign in again',
      'at.busy': 'Please wait…',

      'confirm.end': 'End this round now?\n\n{name} takes 90% of {pot} ETB immediately.',
      'confirm.cancel': 'Cancel this round and refund {pot} ETB to all depositors?\nNobody wins.',

      'admin.errRequired': 'Enter the admin password',
    },

    am: {
      /* ---------------- shared ---------------- */
      'common.etb': 'ብር',
      'lang.label': 'EN',

      /* ---------------- game ---------------- */
      'nav.play': 'ጨዋታ',
      'nav.board': 'ደረጃ',
      'nav.me': 'እኔ',
      'brand.name': 'ታይም ቦምብ',
      'brand.tagline': 'የመጨረሻው ተቀማጭ ያሸንፋል',

      'status.live': 'ቀጥታ',
      'status.paused': 'ቆሟል',
      'status.settled': 'ተጠናቅቋል',
      'status.cancelled': 'ተሰርዟል',
      'status.arming': 'በመዘጋጀት ላይ…',
      'status.idle': 'ባዶ',
      'status.reconnecting': 'በመገናኘት ላይ…',
      'chip.inRound': 'በዙር ውስጥ',
      'chip.round': 'ዙር',

      'timer.fuse': 'ጊዜ',
      'timer.sec': 'ሰከንድ',
      'timer.seconds': 'ሰከንድ',
      'pot.label': 'ሽልማት',

      'last.none': 'እስካሁን ማንም አልገባም — ፊተኛው ይሁኑ',
      'last.lastIn': 'የመጨረሻ ገቢ፦',
      'last.wouldWin': '{amount} ብር ያሸንፋል',
      'last.won': '{name} {amount} ብር ወስዷል',
      'last.cancelled': 'ዙሩ ተሰርዟል — ሁሉም ገቢዎች ተመላሽ ሆነዋል',
      'last.paused': 'ጨዋታው በአስተዳዳሪው ቆሟል',

      'btn.push': 'አስገባ <b>{fee}</b> ብር',
      'btn.openTelegram': 'በቴሌግራም ክፈት',
      'btn.sub': 'ጊዜውን ወደ {sec} ሰከንድ ይመልሳል · አሸናፊው {pct}% ይወስዳል',

      'hint.default':
        'እያንዳንዱ ገቢ ወደ ሽልማቱ ይጨመራል፤ ስምዎም በላዩ ላይ ይቀመጣል። ጊዜው ሲያልቅ የመጨረሻው ስም ያሸንፋል።',
      'hint.telegramOnly': 'ለመጫወት ጨዋታውን ከቴሌግራም ቦት ይክፈቱ — የቴሌግራም መገለጫዎ አካውንትዎ ነው።',
      'hint.paused': 'አስተዳዳሪው ጨዋታውን አቁሟል — ይጠብቁ።',
      'hint.waiting': 'ቀጣዩ ቦምብ እስኪዘጋጅ በመጠበቅ ላይ…',
      'hint.needFunds': 'ለመግባት {fee} ብር ያስፈልግዎታል። ቦርሳዎን እንዲሞላ አስተዳዳሪውን ይጠይቁ።',

      'feed.title': 'የቀጥታ ገቢዎች',
      'feed.empty': 'የመጀመሪያውን ገቢ በመጠበቅ ላይ…',
      'feed.waiting': 'ዙር እስኪጀመር በመጠበቅ ላይ…',
      'feed.countOne': '{n} ገቢ',
      'feed.countMany': '{n} ገቢዎች',

      'time.justNow': 'አሁን',
      'time.secAgo': '{n} ሰከንድ በፊት',
      'time.minAgo': '{n} ደቂቃ በፊት',
      'time.hourAgo': '{n} ሰዓት በፊት',

      'board.house': 'የቤቱ ገቢ',
      'board.paid': 'ለአሸናፊዎች የተከፈለ',
      'board.rounds': 'የተጫወቱ ዙሮች',
      'board.maxPot': 'ትልቁ ሽልማት',
      'board.topWinners': 'ከፍተኛ አሸናፊዎች',
      'board.recent': 'የቅርብ ጊዜ ዙሮች',
      'board.noWinners': 'እስካሁን አሸናፊ የለም — የመጀመሪያው ይሁኑ።',
      'board.noRounds': 'የዙር ታሪክ እዚህ ይታያል።',
      'board.winOne': '{n} ድል',
      'board.winMany': '{n} ድሎች',
      'board.noWinner': 'አሸናፊ የለም',
      'board.cancelled': 'ተሰርዟል',

      'me.wallet': 'ቦርሳ',
      'me.wins': 'ድሎች',
      'me.winnings': 'የተሸለመ',
      'me.pushes': 'ገቢዎች',
      'me.guest': 'እንግዳ',
      'me.notInTelegram': 'ለመጫወት ከቴሌግራም ይክፈቱ',
      'me.walletLine': 'ቦርሳ {amount} ብር',
      'me.telegramId': 'የቴሌግራም መታወቂያ {id}',
      'me.rulesTitle': 'ቦምቡ እንዴት ይሰራል',
      'me.rules1': 'ጊዜው በ30 ሰከንድ ይጀምራል። እያንዳንዱ ገቢ ወደ መጀመሪያው ይመልሰዋል።',
      'me.rules2': 'እያንዳንዱ ገቢ ቋሚውን የመግቢያ ክፍያ ይወስዳል፤ ሽልማቱንም ያሳድጋል።',
      'me.rules3': 'ጊዜው 00:00 ሲደርስ ማንም ማስገባት አይችልም።',
      'me.rules4': 'የመጨረሻው ተቀማጭ 90% ይወስዳል። ቤቱ 10% ይይዛል።',
      'me.rules5': 'ጊዜው በሚያልቅበት ቅጽበት አሸናፊው በቦርሳው ይከፈላል።',
      'me.footnote': 'የመጫወቻ ገንዘብ ብቻ። የክፍያ አገልግሎት እስኪገናኝ ድረስ ቦርሳዎች በአስተዳዳሪው ይሞላሉ።',

      'winner.label': 'ጊዜው አለቀ',
      'winner.took': 'የመጨረሻው ሆኖ ወስዷል',
      'winner.cut': 'ሽልማት {pot} · የቤቱ ክፍል {cut}',
      'winner.next': 'ቀጣዩ ቦምብ በ<b>{n}</b> ሰከንድ…',
      'winner.arming': 'ቀጣዩ ቦምብ በመዘጋጀት ላይ…',

      'toast.push': 'ገብተዋል! ጊዜው ወደ {sec} ሰከንድ ተመልሷል — ሽልማቱ በእርስዎ እጅ ነው',
      'toast.noFunds': 'በቦርሳዎ ውስጥ በቂ ብር የለም',
      'toast.cancelled': 'ዙሩ ተሰርዟል — ሁሉም ገቢዎች ተመላሽ ሆነዋል',
      'toast.muted': 'የጊዜ ድምፅ አሉፍ',
      'toast.unmuted': 'የጊዜ ድምፅ ሰርቷል',

      /* ---------------- server errors ---------------- */
      'err.round_not_live': 'አሁን ምንም የቀጥታ ዙር የለም',
      'err.paused': 'ጨዋታው በአስተዳዳሪው ቆሟል',
      'err.spam': 'ቀስ ይበሉ — ለአንድ ሰከንድ ይጠብቁ',
      'err.insufficient_funds': 'በቦርሳዎ ውስጥ በቂ ብር የለም',
      'err.banned': 'ይህ አካውንት ታግዷል',
      'err.signed_out': 'ለመቀጠል እባክዎ ይግቡ',
      'err.account_missing': 'አካውንት አልተገኘም',
      'err.telegram_only': 'ለመጫወት ጨዋታውን በቴሌግራም ውስጥ ይክፈቱ',
      'err.telegram_invalid': 'የቴሌግራም መግቢያ አልተሳካም — ጨዋታውን ከቴሌግራም እንደገና ይክፈቱ',
      'err.too_many': 'ብዙ ሙከራዎች — ጥቂት ደቂቃዎች ይጠብቁ',
      'err.no_round': 'አሁን የቀጥታ ዙር የለም',
      'err.round_live': 'ዙር አስቀድሞ በሂደት ላይ ነው',
      'err.positive_amount': 'አዎንታዊ መጠን ያስገቡ',
      'err.too_large': 'መጠኑ በጣም ትልቅ ነው',
      'err.player_not_found': 'ተጫዋች አልተገኘም',
      'err.wrong_admin': 'የተሳሳተ የአስተዳደር ይለፍ ቃል',
      'err.server': 'የሰርቨር ስህተት — እንደገና ይሞክሩ',

      /* ---------------- admin ---------------- */
      'admin.brand': 'የቁጥጥር ክፍል',
      'admin.sub': 'የታይም ቦምብ አስተዳደር',
      'admin.gameLink': 'ጨዋታ ↗',
      'admin.exit': 'ውጣ',
      'admin.loginTitle': 'ታይም ቦምብ',
      'admin.loginSub': 'የአስተዳደር ቁጥጥር ክፍል',
      'admin.password': 'የአስተዳደር የይለፍ ቃል',
      'admin.unlock': 'ፓነሉን ክፈት',
      'admin.db': 'db: {mode}',
      'admin.expired': 'ክፍለ ጊዜው አልቋል — እንደገና ይግቡ',

      'stats.house': 'የቤቱ ገቢ',
      'stats.paid': 'ለአሸናፊዎች የተከፈለ',
      'stats.rounds': 'የተጫወቱ ዙሮች',
      'stats.players': 'ተጫዋቾች',

      'live.title': 'የቀጥታ ቁጥጥር',
      'live.round': 'ዙር #{no}',
      'live.noRound': 'ዙር የለም',
      'live.fuse': 'ጊዜ',
      'live.pot': 'ሽልማት',
      'live.last': 'የመጨረሻ ተቀማጭ',
      'live.pushes': 'በዚህ ዙር የገቡ',
      'live.players': 'በዙር ውስጥ ተጫዋቾች',
      'live.pause': 'ጨዋታውን አቁም',
      'live.resume': 'ጨዋታውን ቀጥል',
      'live.end': 'ዙሩን አሁን ጨርስ',
      'live.cancel': 'ሰርዝ እና መልስ',
      'live.start': 'አዲስ ዙር ጀምር',
      'live.hint':
        '«ዙሩን አሁን ጨርስ» ለአሁኑ የመጨረሻ ተቀማጭ 90% ወዲያውኑ ይከፍላል። «ሰርዝ እና መልስ» በዙሩ ውስጥ ያለውን ገንዘብ ሁሉ መልሶ ለማንም አይከፍልም።',

      'set.title': 'የጨዋታ ቅንብሮች',
      'set.entryFee': 'የመግቢያ ክፍያ (ብር)',
      'set.houseCut': 'የቤቱ ክፍያ (%)',
      'set.startSeconds': 'የመጀመሪያ ጊዜ (ሰከንድ)',
      'set.resetSeconds': 'ከገቢ በኋላ ጊዜ (ሰከንድ)',
      'set.startingBalance': 'የአዲስ ተጫዋች ቦርሳ (ብር)',
      'set.gap': 'የመድገም ክፍተት (ሚሊሰከንድ)',
      'set.autoStart': 'ከየዙሩ በኋላ ቀጣዩን በራስሰር ጀምር',
      'set.save': 'ቅንብሮችን አስቀምጥ',
      'set.saving': 'በማስቀመጥ ላይ…',
      'set.hint': 'ለውጦቹ ወዲያውኑ ይተገበራሉ። አዲሱ የመግቢያ ክፍያና ጊዜ ለአሁኑ ዙርም ይጠቀማሉ።',
      'set.saved': 'ተቀምጧል {time}',

      'players.title': 'ተጫዋቾች',
      'players.search': 'በስም ወይም በቴሌግራም መታወቂያ ይፈልጉ…',
      'players.player': 'ተጫዋች',
      'players.wallet': 'ቦርሳ',
      'players.wins': 'ድሎች',
      'players.actions': 'እርምጃዎች',
      'players.empty': 'እስካሁን ተጫዋች የለም',
      'players.deposit': 'አስገባ',
      'players.withdraw': 'አውጣ',
      'players.hint': 'ለየትኛውም ተጫዋች ብር ማስገባት ወይም ማውጣት ይችላሉ። ማውጣት ቦርሳን ከዜሮ በታች አያደርግም።',
      'players.noPhone': 'ስልክ የለም',
      'players.banned': 'ታግዷል',
      'players.ban': 'አግድ',
      'players.unban': 'ክፈት',

      'rounds.title': 'የቅርብ ዙሮች',
      'rounds.no': '#',
      'rounds.winner': 'አሸናፊ',
      'rounds.pot': 'ሽልማት',
      'rounds.payout': 'የተከፈለ',
      'rounds.house': 'ቤት',
      'rounds.state': 'ሁኔታ',
      'rounds.empty': 'እስካሁን ዙር የለም',
      'rounds.inProgress': 'በሂደት ላይ',
      'rounds.none': '—',

      'modal.title': 'የተጫዋች ቦርሳ',
      'modal.sub': 'ቦርሳ {amount} ብር — የሚስተካከለው መጠን',
      'modal.credit': 'አስገባ',
      'modal.debit': 'አውጣ',

      'at.paused': 'ጨዋታው ቆሟል — ጊዜው ታግዷል',
      'at.resumed': 'ጨዋታው ተቀጥሏል',
      'at.roundSettled': 'ዙሩ ተጠናቅቋል',
      'at.newRound': 'አዲስ ቦምብ ተዘጋጅቷል',
      'at.settingsSaved': 'ቅንብሮች ተቀምጠዋል',
      'at.positiveAmount': 'አዎንታዊ መጠን ያስገቡ',
      'at.autoOn': 'በራስሰር መጀመር በርቷል',
      'at.autoOff': 'በራስሰር መጀመር ጠፍቷል — ዙሮችን በእጅ ይጀምሩ',
      'at.credited': '{amount} ብር ለ{name} ተጨምሯል',
      'at.debited': '{amount} ብር ከ{name} ተቀንሷል',
      'at.banned': '{name} ታግዷል',
      'at.unbanned': '{name} ተከፍቷል',
      'at.deposit': '{name} {amount} ብር አስገብቷል',
      'at.paid': 'ለ{name} {amount} ብር ተከፍሏል',
      'at.recycled': 'ዙሩ ሽልማት አልነበረውም — እንደገና ተጀምሯል',
      'at.refunded': 'ዙሩ ተሰርዟል — {amount} ብር ተመላሽ ሆኗል',
      'at.nothingRefund': 'የሚመለስ ገንዘብ የለም',
      'at.sessionExpired': 'ክፍለ ጊዜው አልቋል — እንደገና ይግቡ',
      'at.busy': 'እባክዎ ይጠብቁ…',

      'confirm.end': 'ይህን ዙር አሁን ጨርስ?\n\n{name} ከ{pot} ብር 90% ወዲያውኑ ይወስዳል።',
      'confirm.cancel': 'ይህን ዙር ሰርዘህ {pot} ብር ለሁሉም ተቀማጮች መልስ?\nማንም አያሸንፍም።',

      'admin.errRequired': 'የአስተዳደር ይለፍ ቃል ያስገቡ',
    },
  };

  const STORE_KEY = 'tb_lang';
  let lang = 'en';
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved && DICT[saved]) lang = saved;
  } catch {
    /* storage blocked */
  }

  const listeners = [];

  function t(key, vars) {
    const table = DICT[lang] || DICT.en;
    let value = table[key];
    if (value === undefined) value = DICT.en[key];
    if (value === undefined) return key;
    if (vars) {
      for (const name of Object.keys(vars)) {
        value = value.split(`{${name}}`).join(String(vars[name]));
      }
    }
    return value;
  }

  function apply(root) {
    const scope = root || document;
    document.documentElement.lang = lang;
    scope.querySelectorAll('[data-i18n]').forEach((node) => {
      node.textContent = t(node.getAttribute('data-i18n'));
    });
    scope.querySelectorAll('[data-i18n-html]').forEach((node) => {
      node.innerHTML = t(node.getAttribute('data-i18n-html'));
    });
    scope.querySelectorAll('[data-i18n-ph]').forEach((node) => {
      node.placeholder = t(node.getAttribute('data-i18n-ph'));
    });
    scope.querySelectorAll('[data-i18n-title]').forEach((node) => {
      node.title = t(node.getAttribute('data-i18n-title'));
    });
    scope.querySelectorAll('[data-lang-label]').forEach((node) => {
      node.textContent = lang === 'en' ? 'አማርኛ' : 'EN';
    });
  }

  function setLang(next) {
    lang = DICT[next] ? next : 'en';
    try {
      localStorage.setItem(STORE_KEY, lang);
    } catch {
      /* storage blocked */
    }
    apply();
    listeners.forEach((fn) => {
      try {
        fn(lang);
      } catch (err) {
        console.error(err);
      }
    });
  }

  function toggle() {
    setLang(lang === 'en' ? 'am' : 'en');
  }

  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.addEventListener('click', (event) => {
      const trigger = event.target.closest('[data-lang-toggle]');
      if (trigger) {
        event.preventDefault();
        toggle();
      }
    });
  });

  window.I18n = {
    t,
    apply,
    setLang,
    toggle,
    onChange: (fn) => listeners.push(fn),
    get lang() {
      return lang;
    },
  };
})();
