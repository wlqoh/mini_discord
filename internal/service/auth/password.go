package auth

import "golang.org/x/crypto/bcrypt"

// HashPassword hashes password with bcrypt at the default cost, for
// storing in place of the plaintext.
func HashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

// ComparePasswords reports whether plain matches the bcrypt hash produced
// by HashPassword.
func ComparePasswords(hashed string, plain []byte) bool {
	err := bcrypt.CompareHashAndPassword([]byte(hashed), plain)
	return err == nil
}
