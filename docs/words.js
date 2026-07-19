// English words in approximate descending frequency of use (based on common
// corpus frequency lists such as COCA / Google Books). The learning engine
// walks this list from the top: the highest-frequency words the user has NOT
// yet used themselves become the agent's target vocabulary.

const RAW_LIST = [
  // 1–50
  "the", "be", "to", "of", "and", "a", "in", "that", "have", "I",
  "it", "for", "not", "on", "with", "he", "as", "you", "do", "at",
  "this", "but", "his", "by", "from", "they", "we", "say", "her", "she",
  "or", "an", "will", "my", "one", "all", "would", "there", "their", "what",
  "so", "up", "out", "if", "about", "who", "get", "which", "go", "me",
  // 51–100
  "when", "make", "can", "like", "time", "no", "just", "him", "know", "take",
  "people", "into", "year", "your", "good", "some", "could", "them", "see", "other",
  "than", "then", "now", "look", "only", "come", "its", "over", "think", "also",
  "back", "after", "use", "two", "how", "our", "work", "first", "well", "way",
  "even", "new", "want", "because", "any", "these", "give", "day", "most", "us",
  // 101–150
  "find", "here", "thing", "many", "tell", "long", "very", "still", "should", "own",
  "down", "life", "before", "right", "too", "mean", "old", "same", "big", "feel",
  "high", "off", "try", "leave", "put", "world", "home", "school", "little", "never",
  "last", "another", "while", "ask", "house", "again", "part", "seem", "place", "why",
  "help", "turn", "start", "might", "show", "every", "hear", "run", "move", "play",
  // 151–200
  "live", "believe", "hold", "bring", "happen", "must", "write", "provide", "sit", "stand",
  "lose", "pay", "meet", "include", "continue", "set", "learn", "change", "lead", "understand",
  "watch", "follow", "stop", "create", "speak", "read", "allow", "add", "spend", "grow",
  "open", "walk", "win", "offer", "remember", "love", "consider", "appear", "buy", "wait",
  "serve", "send", "expect", "build", "stay", "fall", "cut", "reach", "keep", "remain",
  // 201–250
  "suggest", "raise", "pass", "sell", "require", "report", "decide", "pull", "family", "night",
  "water", "mother", "area", "money", "story", "fact", "month", "lot", "study", "book",
  "eye", "job", "word", "business", "issue", "side", "kind", "head", "far", "black",
  "both", "since", "always", "week", "name", "room", "friend", "father", "power", "hour",
  "game", "line", "end", "member", "law", "car", "city", "community", "young", "important",
  // 251–300
  "bad", "few", "next", "early", "group", "problem", "hard", "number", "country", "point",
  "government", "company", "question", "during", "woman", "man", "child", "state", "war", "real",
  "best", "team", "minute", "idea", "body", "information", "nothing", "ago", "lead", "social",
  "president", "case", "morning", "different", "small", "large", "national", "often", "food", "sure",
  "without", "second", "later", "himself", "less", "public", "almost", "hand", "enough", "student",
  // 301–350
  "however", "person", "art", "history", "party", "result", "today", "bit", "music", "call",
  "moment", "air", "force", "education", "foot", "boy", "age", "girl", "door", "answer",
  "clear", "guy", "usually", "several", "possible", "against", "late", "hope", "example", "yes",
  "along", "wrong", "already", "though", "free", "either", "close", "class", "reason", "human",
  "across", "kid", "yet", "true", "matter", "office", "eat", "research", "sense", "certain",
  // 351–400
  "level", "everything", "process", "teacher", "data", "although", "act", "century", "course", "street",
  "difference", "die", "death", "experience", "better", "service", "away", "himself", "wife", "future",
  "whole", "hundred", "control", "field", "least", "cost", "industry", "figure", "face", "market",
  "letter", "color", "behind", "value", "special", "growth", "product", "picture", "policy", "series",
  "toward", "list", "short", "single", "position", "player", "fire", "clearly", "energy", "type",
  // 401–450
  "space", "situation", "voice", "form", "health", "practice", "piece", "language", "region", "chance",
  "development", "role", "computer", "town", "ground", "letter", "hospital", "church", "risk", "everyone",
  "center", "care", "increase", "personal", "society", "north", "south", "wall", "movie", "record",
  "birth", "common", "nature", "trade", "beautiful", "someone", "table", "court", "song", "phone",
  "travel", "science", "brother", "sister", "summer", "winter", "morning", "evening", "weather", "coffee",
  // 451–500
  "restaurant", "kitchen", "garden", "window", "animal", "flower", "mountain", "river", "ocean", "island",
  "airplane", "train", "hotel", "vacation", "holiday", "birthday", "family", "neighbor", "market", "store",
  "clothes", "shoes", "breakfast", "lunch", "dinner", "fruit", "vegetable", "bread", "cheese", "chicken",
  "doctor", "nurse", "police", "driver", "farmer", "artist", "singer", "dance", "swim", "cook",
  "clean", "wash", "sleep", "dream", "smile", "laugh", "cry", "angry", "happy", "tired",
];

// Deduplicate while preserving first-occurrence (highest-frequency) order.
export const WORD_FREQUENCY = [...new Set(RAW_LIST.map((w) => w.toLowerCase()))];
