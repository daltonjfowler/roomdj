// Filling the lists (Dalton, 2026-10-31: "look for the most popular songs in each genre and fill the
// list by checking for appropriate music so we have a full list"). `npm run songbook` takes each list's
// artists (its hand seeds' and these), asks iTunes for each artist's songs (most popular first) and adds
// the top DEPTH ones that are NOT explicit (not even a clean edit: those are the ones the check passes),
// each artist's #1 first, then each one's #2, up to MAX songs a list. The same rules as every seed: NOT
// approvals; the song check decides each one before a list shows it.
// No depth for 🎬 Movies and 🎭 Musicals (an actor's other songs are not movie songs), 🎮 Games & anime, 📻 Throwbacks (by year: the
// archive fills it), 🎻 Classical and 📚 Focus (one piece, a hundred recordings).

/** Songs per artist, per list. */
export const DEPTH = {
  pop: 4, hiphop: 6, country: 6, rock: 4, latin: 6, kpop: 6, dance: 6,
  classicrock: 5, indie: 5, punk: 5, metal: 6, soul: 5, reggae: 6, afrobeats: 6, jazz: 5,
  world: 5, folk: 5, gospel: 5,
};
/** Songs a list may have in all (hand seeds first): more where the check passes fewer. */
export const MAX = { hiphop: 700, latin: 450, country: 420, indie: 420 };
export const MAX_DEFAULT = 340;
/**
 * Songs an artist's top songs never bring in (title - artist), Dalton's own calls: the check could
 * still miss them, so they are not even asked about.
 */
export const SKIP = [
  'Nausea - Jeff Rosenstock', // "nausea is about alcohol" (Dalton, 2026-10-31)
  'Turtles All the Way Down - Sturgill Simpson', // drugs
  'You Can Have the Crown - Sturgill Simpson', // weed, swearing
  'Whitehouse Road - Tyler Childers', // drugs
  'Time to Pretend - MGMT', // drugs
];

export const ARTISTS = {
  pop: [
    'Ed Sheeran', 'Dua Lipa', 'Tate McRae', 'Gracie Abrams', 'Conan Gray', 'Ariana Grande', 'Justin Bieber', 'Shawn Mendes',
    'Camila Cabello', 'Selena Gomez', 'Meghan Trainor', 'Lewis Capaldi', 'Sia', 'P!nk', 'Kelly Clarkson', 'Jonas Brothers',
    'Bruno Mars', 'Coldplay', 'OneRepublic', 'Ellie Goulding', 'Noah Kahan', 'Lauv', 'Charlie Puth', 'Jason Mraz',
    'Rachel Platten', 'Ava Max', 'Bebe Rexha', 'Zara Larsson', 'RAYE', 'Hailee Steinfeld', 'Demi Lovato', 'Lady Gaga',
  ],
  hiphop: [
    'Drake', 'Kendrick Lamar', 'J. Cole', 'Lil Nas X', 'Doja Cat', 'SZA', 'Usher', 'Chris Brown', 'Beyoncé', 'Rihanna',
    'Pharrell Williams', 'Missy Elliott', 'OutKast', 'Will Smith', 'Kanye West', 'JAY-Z', 'Nelly', 'Flo Rida', 'Pitbull', 'T-Pain',
    'Jason Derulo', 'Ne-Yo', 'Sean Kingston', 'Lil Wayne', 'Eminem', 'Post Malone', 'Jack Harlow', 'Lizzo', 'Khalid', 'H.E.R.',
    'Daniel Caesar', 'Giveon', 'Childish Gambino', 'Chance the Rapper', 'Kid Cudi', 'Logic', 'NF', 'Macklemore', 'Lecrae', 'KB',
    'MC Hammer', 'Vanilla Ice', 'The Sugarhill Gang', 'RUN DMC', 'LL COOL J', 'Queen Latifah', 'Salt-N-Pepa', 'TLC', "Destiny's Child", 'Boyz II Men',
    'Alicia Keys', 'John Legend', 'Mary J. Blige', 'Mariah Carey', 'Whitney Houston', 'Janet Jackson', 'Ciara', 'Kehlani', 'Victoria Monét', 'Coco Jones',
    'Muni Long', 'Mario', 'The Weeknd', 'Frank Ocean', 'Anderson .Paak', 'Silk Sonic', 'Megan Thee Stallion', 'Nicki Minaj', 'Big Sean', 'Soulja Boy',
    'Cupid', 'Ludacris', 'Black Eyed Peas', 'Fugees', 'Ms. Lauryn Hill', 'A Tribe Called Quest', 'De La Soul', 'Coolio', 'DJ Khaled', 'Roddy Ricch',
    'Lil Baby', 'Gunna', 'Travis Scott', 'Tyler, The Creator', 'GloRilla', 'Doechii', 'Latto', 'Ice Spice', 'Bryson Tiller', 'Summer Walker',
    'Aesop Rock',
  ],
  country: [
    'Morgan Wallen', 'Luke Combs', 'Zach Bryan', 'Chris Stapleton', 'Billy Strings', 'Kane Brown', 'Luke Bryan', 'Jason Aldean', 'Blake Shelton',
    'Carrie Underwood', 'Miranda Lambert', 'Kelsea Ballerini', 'Lainey Wilson', 'Jelly Roll', 'Bailey Zimmerman', 'Cody Johnson', 'Riley Green',
    'Thomas Rhett', 'Sam Hunt', 'Dan + Shay', 'Old Dominion', 'Brett Young', 'Jordan Davis', 'Chris Young', 'Keith Urban',
    'Tim McGraw', 'Faith Hill', 'Kenny Chesney', 'Brad Paisley', 'Toby Keith', 'Alan Jackson', 'George Strait', 'Garth Brooks',
    'Reba McEntire', 'Shania Twain', 'Dolly Parton', 'Johnny Cash', 'Willie Nelson', 'Dierks Bentley', 'Florida Georgia Line', 'Rascal Flatts',
    'Lady A', 'Little Big Town', 'Zac Brown Band', 'HARDY', 'Parker McCollum', 'Megan Moroney', 'Ella Langley', 'Shaboozey',
    'Tucker Wetmore', 'Dasha', 'Warren Zeiders', 'Russell Dickerson', 'Scotty McCreery', 'Hunter Hayes', 'Brooks & Dunn', 'Josh Turner',
    'Tyler Childers', 'The Avett Brothers', 'Sierra Ferrell', 'Molly Tuttle', 'Alison Krauss',
  ],
  rock: [
    'Imagine Dragons', 'Coldplay', 'The Killers', 'Foo Fighters', 'Green Day', 'Linkin Park', 'Red Hot Chili Peppers', 'AC/DC',
    'Queen', 'Bon Jovi', 'Journey', 'Arctic Monkeys', 'twenty one pilots', 'Fall Out Boy', 'Panic! At The Disco', 'Paramore',
    'Muse', 'Kings of Leon', 'The Black Keys', 'Cage the Elephant', 'Shinedown', 'Three Days Grace', 'Daughtry', 'Nickelback',
    '3 Doors Down', 'Matchbox Twenty', 'Goo Goo Dolls', 'X Ambassadors', 'AJR', 'Bastille', 'Royal Blood', 'Greta Van Fleet',
    'Måneskin', 'The White Stripes', 'Weezer', 'Switchfoot', 'Lifehouse', 'The Fray', 'Train', 'Hoobastank',
    'Collective Soul', 'Creed', 'Vertical Horizon', 'Evanescence', 'Skillet', 'Papa Roach', 'Halestorm', 'The Pretty Reckless',
    'John Mayer', 'Queens of the Stone Age', 'Wolfmother', 'Jack White',
  ],
  latin: [
    'Bad Bunny', 'KAROL G', 'Shakira', 'J Balvin', 'Daddy Yankee', 'Maluma', 'Ozuna', 'Rauw Alejandro', 'Peso Pluma', 'Grupo Frontera',
    'Fuerza Regida', 'Eslabon Armado', 'Carin León', 'Junior H', 'Becky G', 'Romeo Santos', 'Aventura', 'Prince Royce', 'Enrique Iglesias', 'Ricky Martin',
    'Marc Anthony', 'Gloria Estefan', 'Celia Cruz', 'Selena', 'Juanes', 'Carlos Vives', 'Maná', 'Rosalía', 'Sebastián Yatra', 'Manuel Turizo',
    'Feid', 'Myke Towers', 'Luis Fonsi', 'Nicky Jam', 'Wisin & Yandel', 'Don Omar', 'CNCO', 'Camilo', 'Morat', 'Reik',
    'Jesse & Joy', 'Julieta Venegas', 'Natalia Lafourcade', 'Vicente Fernández', 'Alejandro Fernández', 'Luis Miguel', 'Juan Gabriel', 'Los Ángeles Azules', 'Banda MS', 'Calibre 50',
    'Christian Nodal', 'Ángela Aguilar', 'Kali Uchis', 'Danny Ocean', 'Elvis Crespo', 'Gente de Zona', 'Santana', 'Los Lobos', 'Mon Laferte', 'Xavi',
    'Bomba Estéreo', 'Buena Vista Social Club',
  ],
  kpop: [
    'BTS', 'BLACKPINK', 'TWICE', 'Stray Kids', 'SEVENTEEN', 'NewJeans', 'LE SSERAFIM', 'IVE', 'aespa', 'i-dle',
    'ITZY', 'ENHYPEN', 'TOMORROW X TOGETHER', 'ATEEZ', 'NCT 127', 'NCT DREAM', 'EXO', 'Red Velvet', 'BIGBANG', 'PSY',
    'Jung Kook', 'Jimin', 'ROSÉ', 'JENNIE', 'LISA', 'IU', 'BABYMONSTER', 'ILLIT', 'KISS OF LIFE', 'RIIZE',
    'ZEROBASEONE', 'BOYNEXTDOOR', 'TWS', 'NMIXX', 'STAYC', 'MAMAMOO', 'SHINee', "Girls' Generation", 'KATSEYE', 'HUNTR/X',
  ],
  dance: [
    'Calvin Harris', 'David Guetta', 'Tiësto', 'Skrillex', 'deadmau5', 'Kaskade', 'ILLENIUM', 'Porter Robinson', 'Madeon', 'ODESZA',
    'Disclosure', 'Kygo', 'Alesso', 'Zedd', 'Marshmello', 'Avicii', 'Martin Garrix', 'Swedish House Mafia', 'Daft Punk', 'Justice',
    'The Chemical Brothers', 'Fatboy Slim', 'Moby', 'Eric Prydz', 'Above & Beyond', 'Armin van Buuren', 'Charlotte de Witte', 'Amelie Lens', 'Peggy Gou', 'KAYTRANADA',
    'Diplo', 'Major Lazer', 'Galantis', 'Clean Bandit', 'Robin Schulz', 'Purple Disco Machine', 'Dom Dolla', 'John Summit', 'Fred again..', 'Chris Lake',
    'MEDUZA', 'Lost Frequencies', 'Alok', 'Afrojack', 'Hardwell', 'Steve Aoki', 'Gryffin', 'Seven Lions', 'Flume', 'RÜFÜS DU SOL',
    'Fisher', 'Anyma', 'Mau P', 'Sammy Virji', 'Joel Corry', 'Sofi Tukker', 'The Chainsmokers', 'Alan Walker', 'DJ Snake', 'Kungs',
  ],
  classicrock: [
    'The Beatles', 'The Rolling Stones', 'Led Zeppelin', 'Queen', 'The Who', 'Eagles', 'Fleetwood Mac', 'Journey', 'Boston', 'Kansas',
    'Styx', 'Foreigner', 'Heart', 'Toto', 'Electric Light Orchestra', 'Tom Petty and the Heartbreakers', 'Bruce Springsteen', 'Bob Seger', 'John Mellencamp', 'Creedence Clearwater Revival',
    'Lynyrd Skynyrd', 'The Allman Brothers Band', 'ZZ Top', 'Van Halen', 'AC/DC', 'Aerosmith', 'KISS', 'Def Leppard', 'Rush', 'Genesis',
    'Steve Miller Band', 'The Doobie Brothers', 'Chicago', 'Santana', 'The Doors', 'Jimi Hendrix', 'Cream', 'Eric Clapton', 'The Beach Boys', 'Simon & Garfunkel',
    'The Kinks', 'The Animals', 'The Monkees', 'Buddy Holly', 'Chuck Berry', 'Elvis Presley', 'Little Richard', 'Roy Orbison', 'Bachman-Turner Overdrive', 'Blue Öyster Cult',
    'Bad Company', 'Thin Lizzy', 'Cheap Trick', 'The Cars', 'Billy Joel', 'Elton John', 'David Bowie', 'Pat Benatar', 'REO Speedwagon', 'Kenny Loggins',
    'Pink Floyd',
  ],
  indie: [
    'Nirvana', 'Pearl Jam', 'Soundgarden', 'R.E.M.', 'Radiohead', 'The Cranberries', 'The Smashing Pumpkins', 'Weezer', 'Oasis', 'Blur',
    'The Cure', 'Talking Heads', 'New Order', 'Depeche Mode', 'Tears for Fears', 'The Smiths', 'Pixies', 'Vampire Weekend', 'Two Door Cinema Club', 'Hozier',
    'Glass Animals', 'Tame Impala', 'The Neighbourhood', 'Lord Huron', 'The Lumineers', 'Mumford & Sons', 'Of Monsters and Men', 'Vance Joy', 'Noah Kahan', 'Mitski',
    'Clairo', 'beabadoobee', 'Wallows', 'Dayglow', 'Hippo Campus', 'Peach Pit', 'The Marías', 'Djo', 'sombr', 'Young the Giant',
    'WALK THE MOON', 'Bleachers', 'fun.', 'Portugal. The Man', 'Death Cab for Cutie', 'The Shins', 'Fleet Foxes', 'The National', 'Arcade Fire', 'Franz Ferdinand',
    'The Wombats', 'Catfish and the Bottlemen', 'Phoebe Bridgers', 'boygenius', 'Lana Del Rey', 'Lorde', 'Alanis Morissette', 'Stone Temple Pilots', 'Alice In Chains', 'Bush',
    'Men I Trust', 'Kate Bollinger', 'natalie jinju', 'Suki Waterhouse', 'Mac DeMarco', 'Phoenix',
    'Fontaines D.C.', 'The Strokes', 'Khruangbin', 'Alvvays', 'Japanese Breakfast', 'Faye Webster', 'Big Thief', 'Bon Iver',
  ],
  punk: [
    'Green Day', 'blink-182', 'The Offspring', 'Sum 41', 'Fall Out Boy', 'Paramore', 'My Chemical Romance', 'All Time Low', 'Simple Plan', 'Good Charlotte',
    'New Found Glory', 'Yellowcard', 'The All-American Rejects', 'Avril Lavigne', 'Jimmy Eat World', 'Taking Back Sunday', 'Neck Deep', 'State Champs', 'Mayday Parade', 'We The Kings',
    'Boys Like Girls', 'Ramones', 'The Clash', 'Bad Religion', 'Rise Against', 'Pennywise', 'NOFX', 'Rancid', 'Dropkick Murphys', 'Social Distortion',
    'The Interrupters', 'Reel Big Fish', 'Less Than Jake', 'Bowling For Soup', 'Motion City Soundtrack', 'PVRIS', 'Waterparks', 'Pierce The Veil', 'Sleeping With Sirens', 'Meet Me @ The Altar',
    'Turnstile', 'Descendents', 'Buzzcocks', 'The Used', 'Hawthorne Heights', 'Dashboard Confessional', 'Story of the Year', 'Relient K', 'Hey Monday', 'Real Friends',
    'Jeff Rosenstock', 'Streetlight Manifesto',
  ],
  metal: [
    'Metallica', 'Iron Maiden', 'Black Sabbath', 'Ozzy Osbourne', 'Judas Priest', 'Megadeth', 'Anthrax', 'Pantera', 'System Of A Down', 'Korn',
    'Avenged Sevenfold', 'Disturbed', 'Five Finger Death Punch', 'Godsmack', 'Breaking Benjamin', 'Three Days Grace', 'Bullet For My Valentine', 'Trivium', 'Gojira', 'Mastodon',
    'Ghost', 'Sabaton', 'Nightwish', 'Within Temptation', 'Evanescence', 'Amaranthe', 'BABYMETAL', 'DragonForce', 'Powerwolf', 'Rammstein',
    'Bad Omens', 'Sleep Token', 'Spiritbox', 'Architects', 'Bring Me The Horizon', 'Motionless In White', 'I Prevail', 'Dio', 'Motörhead', 'Scorpions',
    'Whitesnake', 'Europe', 'Twisted Sister', 'Mötley Crüe', 'Skid Row', 'Alice Cooper', 'Deep Purple', 'Halestorm', 'In This Moment', 'Killswitch Engage',
  ],
  soul: [
    'Stevie Wonder', 'Marvin Gaye', 'Aretha Franklin', 'The Temptations', 'The Supremes', 'Diana Ross', 'The Jackson 5', 'Michael Jackson', 'Smokey Robinson & The Miracles', 'Four Tops',
    'Gladys Knight & The Pips', 'Otis Redding', 'Sam Cooke', 'Al Green', 'Bill Withers', 'Earth, Wind & Fire', 'Kool & The Gang', 'CHIC', 'Sister Sledge', 'Bee Gees',
    'Donna Summer', 'Gloria Gaynor', 'Commodores', 'Lionel Richie', 'Parliament', 'James Brown', 'Sly & The Family Stone', 'Prince', 'Chaka Khan', 'Luther Vandross',
    'Amy Winehouse', 'Leon Bridges', 'Vulfpeck', 'Cory Wong', 'Jungle', 'Durand Jones & The Indications', 'Charles Bradley', 'Sharon Jones & The Dap-Kings', 'Curtis Mayfield', 'The Isley Brothers',
    "The O'Jays", 'The Spinners', 'Daryl Hall & John Oates', 'Wilson Pickett', 'Sam & Dave', 'Martha Reeves & The Vandellas', 'The Drifters', 'The Platters', 'Frankie Valli & The Four Seasons', 'Jackie Wilson',
    'Anderson .Paak', 'Silk Sonic', 'Thundercat', 'Black Pumas', 'Michael Kiwanuka',
  ],
  reggae: [
    'Bob Marley & The Wailers', 'Peter Tosh', 'Jimmy Cliff', 'Toots & The Maytals', 'UB40', 'Inner Circle', 'Ziggy Marley', 'Stephen Marley', 'Burning Spear', 'Desmond Dekker',
    'Third World', 'Steel Pulse', 'Aswad', 'Shaggy', 'Sean Paul', 'Beenie Man', 'Chaka Demus & Pliers', 'Koffee', 'Chronixx', 'Protoje',
    'Rebelution', 'SOJA', 'Stick Figure', 'Iration', 'Matisyahu', 'The Green', 'J Boog', 'Common Kings', 'Collie Buddz', 'MAGIC!',
    'Eddy Grant', 'Johnny Nash', 'Gregory Isaacs', 'Dennis Brown', 'Alton Ellis', 'The Specials', 'Madness', 'The English Beat', 'The Selecter', 'Bad Manners',
    'The Skatalites', 'Prince Buster', 'Reel Big Fish', 'No Doubt', 'The Mighty Mighty Bosstones', 'Streetlight Manifesto', 'Goldfinger', 'The Interrupters', 'Save Ferris', 'The Aquabats!',
  ],
  afrobeats: [
    'Burna Boy', 'Wizkid', 'Davido', 'Rema', 'Tems', 'Tyla', 'Ayra Starr', 'Asake', 'Fireboy DML', 'CKay',
    'Omah Lay', 'Oxlade', 'Victony', 'Kizz Daniel', 'Mr Eazi', 'Yemi Alade', 'Tiwa Savage', 'Simi', 'Adekunle Gold', 'Joeboy',
    'Ruger', 'BNXN', 'Olamide', 'P-Square', '2Baba', 'Fela Kuti', 'Angélique Kidjo', 'Master KG', 'Uncle Waffles', 'Tyler ICU',
    'Black Coffee', 'Sarkodie', 'Stonebwoy', 'Diamond Platnumz', 'Sauti Sol', 'Libianca', 'Tekno', 'Flavour', 'Teni', 'Khaid',
  ],
  jazz: [
    'Louis Armstrong', 'Ella Fitzgerald', 'Duke Ellington', 'Count Basie', 'Benny Goodman', 'Glenn Miller', 'Frank Sinatra', 'Nat King Cole', 'Billie Holiday', 'Sarah Vaughan',
    'Dinah Washington', 'Miles Davis', 'John Coltrane', 'Dave Brubeck', 'Thelonious Monk', 'Charlie Parker', 'Dizzy Gillespie', 'Chet Baker', 'Herbie Hancock', 'Bill Evans',
    'Oscar Peterson', 'Vince Guaraldi Trio', 'Stan Getz', 'Antônio Carlos Jobim', 'Nina Simone', 'Ray Charles', 'Etta James', 'Tony Bennett', 'Michael Bublé', 'Harry Connick, Jr.',
    'Diana Krall', 'Norah Jones', 'Jamie Cullum', 'Gregory Porter', 'Laufey', 'Samara Joy', 'Esperanza Spalding', 'Kamasi Washington', 'Snarky Puppy', 'Trombone Shorty',
    'Preservation Hall Jazz Band', 'Postmodern Jukebox', 'B.B. King', 'Muddy Waters', 'John Lee Hooker', "Howlin' Wolf", 'Stevie Ray Vaughan', 'Buddy Guy', 'Gary Clark Jr.', 'Joe Bonamassa',
    'Keb\' Mo\'', 'Bonnie Raitt', 'Taj Mahal', 'Louis Prima', 'Cab Calloway', 'Fats Waller', 'Scott Joplin', 'Christone "Kingfish" Ingram', 'Big Mama Thornton', 'Robert Cray',
    'BADBADNOTGOOD',
  ],
  world: [
    'YOASOBI', 'Kenshi Yonezu', 'Official HIGE DANdism', 'Fujii Kaze', 'Ado', 'Mrs. GREEN APPLE', 'Arijit Singh', 'A.R. Rahman', 'Shreya Ghoshal', 'Diljit Dosanjh',
    'Stromae', 'Angèle', 'Indila', 'Zaz', 'Édith Piaf', 'Amr Diab', 'Khaled', 'Tarkan', 'Andrea Bocelli', 'Laura Pausini',
    'Enya', 'Celtic Woman', 'The HU', 'Miriam Makeba', 'Ladysmith Black Mambazo', 'Seu Jorge', 'Sergio Mendes', 'Gilberto Gil', 'Bebel Gilberto', 'Teresa Teng',
    'Jay Chou', 'G.E.M.', 'Gipsy Kings', "Israel Kamakawiwo'ole", 'Nathan Evans', 'Mariya Takeuchi', 'Tinariwen', 'Fairuz', 'Nancy Ajram', 'Shankar Mahadevan',
  ],
  folk: [
    'Billy Strings', 'Tony Rice', 'Alison Krauss', 'Old Crow Medicine Show', 'The Lumineers', 'Mumford & Sons', 'The Avett Brothers', 'Fleet Foxes', 'Bon Iver', 'Simon & Garfunkel',
    'Bob Dylan', 'Joni Mitchell', 'John Denver', 'James Taylor', 'Peter, Paul and Mary', 'Woody Guthrie', 'Sierra Ferrell', 'Molly Tuttle', 'The Head and the Heart', 'Nickel Creek',
    'Punch Brothers', 'Sarah Jarosz', 'Gillian Welch', 'The Infamous Stringdusters', 'Ricky Skaggs', 'Bill Monroe', 'Doc Watson', 'Del McCoury Band', 'Rhiannon Giddens', 'Gregory Alan Isakov',
    'Iron & Wine', 'Mt. Joy', 'Watchhouse', 'Darlingside', 'The Steel Wheels', 'Trampled by Turtles', 'Cat Stevens', 'Tracy Chapman', 'Judy Collins', 'Pete Seeger',
  ],
  gospel: [
    'Chris Tomlin', 'Hillsong UNITED', 'Hillsong Worship', 'Elevation Worship', 'Maverick City Music', 'Bethel Music', 'Phil Wickham', 'Lauren Daigle', 'MercyMe', 'TobyMac',
    'Casting Crowns', 'for KING & COUNTRY', 'Zach Williams', 'Brandon Lake', 'Kari Jobe', 'Cory Asbury', 'Matt Redman', 'Matt Maher', 'Tauren Wells', 'Kirk Franklin',
    'Tasha Cobbs Leonard', 'CeCe Winans', 'Marvin Sapp', 'Fred Hammond', 'Mandisa', 'Newsboys', 'Jeremy Camp', 'Crowder', 'Jordan Feliz', 'Anne Wilson',
  ],
};
