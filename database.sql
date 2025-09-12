CREATE TABLE IF NOT EXISTS users (
  user_id INT AUTO_INCREMENT PRIMARY KEY,
  phone VARCHAR(20) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  username VARCHAR(50) NOT NULL,
  profile_logo VARCHAR(255) DEFAULT 'default_avatar.png',
  coins INT DEFAULT 1000,
  total_matches INT DEFAULT 0,
  wins INT DEFAULT 0,
  losses INT DEFAULT 0,
  created_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  match_id INT AUTO_INCREMENT PRIMARY KEY,
  room_id VARCHAR(50) NOT NULL,
  entry_fee INT NOT NULL,
  player1_id INT NOT NULL,
  player2_id INT NOT NULL,
  winner_id INT,
  score_p1 INT DEFAULT 0,
  score_p2 INT DEFAULT 0,
  created_at DATETIME NOT NULL,
  FOREIGN KEY (player1_id) REFERENCES users(user_id),
  FOREIGN KEY (player2_id) REFERENCES users(user_id),
  FOREIGN KEY (winner_id) REFERENCES users(user_id)
);
