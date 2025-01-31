const moment = require('moment');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const { paginatedResponse } = require('../helpers/response');
const { getORQuery } = require('../helpers/query');
const User = require('../models/User');
const ResetPassword = require('../models/ResetPassword');
const Settings = require('../models/Settings');
const { nev } = require('../mail');
const auth = require('../helpers/auth');
const { findIpLocation, isLocalIp } = require('../helpers/localize');
const Subscribers = require('../models/Subscribers');

const config = require('../../config');
const { log } = require('console');
const { CBOARD_PROD_URL, CBOARD_QA_URL, LOCALHOST_PORT_3000_URL } = config;

module.exports = {
  createUser: createUser,
  activateUser: activateUser,
  listUser: listUser,
  removeUser: removeUser,
  getUser: getUser,
  updateUser: updateUser,
  loginUser: loginUser,
  logoutUser: logoutUser,
  getMe: getMe,
  facebookLogin: facebookLogin,
  googleLogin: googleLogin,
  appleLogin,
  googleIdTokenLogin,
  forgotPassword: forgotPassword,
  storePassword: storePassword,
  proxyOauth: proxyOauth,
  getMypatients : getMypatients,
  getOrthoMatri : getOrthoMatri
};

const USER_MODEL_ID_TYPE = {
  facebook: 'facebook.id',
  google: 'google.id',
  apple: 'apple.id'
};

async function getSettings(user) {
  let settings = null;

  try {
    settings = await Settings.getOrCreate({ id: user.id || user._id });
    delete settings.user;
  } catch (e) { }

  return settings;
}

async function getSubscriber(user) {
  let subscriber = null;
  try {
    subscriber = await Subscribers.getByUserId({id: user.id || user._id })
  } catch(e){}



  if(subscriber){
    const product = {
      title: subscriber.product?.title,
      billingPeriod: subscriber.product?.billingPeriod,
      price: subscriber.product?.price
    }
    return {
      id: subscriber._id,
      status: subscriber.status,
      expiryDate: subscriber.transaction?.expiryDate || null,
      product
    }
  }

  return {};
}

async function createUser(req, res) {
  try {
    if (!isLocalIp(req.ip))
      req.body.location = await findIpLocation(req.ip);
  } catch (error) {
    console.error(error.message);
  }

  req.body.isFirstLogin = true;

  if (!req.body.profession || !['orthophoniste', 'patient'].includes(req.body.profession)) {
    return res.status(400).json({
      message: 'Profession is required and must be either "orthophoniste" or "patient".'
    });
  }

  if (req.body.profession === 'patient') {
    // Check if matricule is provided (not empty)
    if (req.body.matricule) {
      try {
        // Verify the matricule exists for an orthophoniste
        const orthophoniste = await User.findOne({ matricule: req.body.matricule, profession: 'orthophoniste' }).exec();
        if (!orthophoniste) {
          return res.status(400).json({
            message: 'The provided matricule does not correspond to any existing orthophoniste.'
          });
        }
      } catch (error) {
        return res.status(500).json({
          message: 'Error occurred while validating the matricule.'
        });
      }
    }
    // If matricule is not provided, no validation is required
  }
  

  // Create a new user instance
  const user = new User(req.body);

  // Check if user already exists
  User.findOne({ email: user.email }, function (err, existingUser) {
    if (err) {
      return res.status(500).json({
        message: 'Error occurred while checking for existing user.'
      });
    }

    // If user already exists, return conflict status
    if (existingUser) {
      return res.status(409).json({
        message: 'You have already signed up and confirmed your account. Did you forget your password?'
      });
    }

    // Save the new user directly in the database
    user.save(function (err) {
      if (err) {
        return res.status(500).json({
          message: 'Error occurred while saving the user.'
        });
      }

      // If user is successfully saved, return success response
      return res.status(200).json({
        success: 1,
        message: 'User successfully created and verified!'
      });
    });
  });
}


async function proxyOauth(req, res) {
  const {accessToken, refreshToken, profile} = req.body;
  const provider = req.swagger.params.provider.value;
  return passportLogin('', provider, accessToken, refreshToken, profile, (req, authRes) => {
    res.json(authRes);
  })
}
// Login from Facebook or Google
async function passportLogin(ip, type, accessToken, refreshToken, profile, done) {
  try {
    const propertyId = USER_MODEL_ID_TYPE[type];
    let user = await User.findOne({ [propertyId]: profile.id })
      .populate('communicators')  
      .exec();


    if (!user) {
      user = await createOrUpdateUser(accessToken, profile, type);
    }

    if (!user.location || !user.location.country)
      try {
        await updateUserLocation(ip, user);
      } catch (error) {
        console.error(error.message);
      }

    const { _id: userId, email } = user;
    const tokenString = auth.issueToken({
      id: userId,
      email
    });

    const settings = await getSettings(user);
    const subscriber = await getSubscriber(user);

    const response = {
      ...user.toJSON(),
      settings,
      subscriber,
      authToken: tokenString
    };

    done(null, response);
  } catch (err) {
    console.error('Passport Login error', err);
    return done(err);
  }
}

async function facebookLogin(req, accessToken, refreshToken, profile, done) {
  const ip = req.ip;
  return passportLogin(ip, 'facebook', accessToken, refreshToken, profile, done);
}

async function googleLogin(req, accessToken, refreshToken, profile, done) {
  const ip = req.ip;
  return passportLogin(ip, 'google', accessToken, refreshToken, profile, done);
}

async function appleLogin(req, accessToken, refreshToken, idToken, profile, done) {
  const decodedUser = jwt.decode(idToken);
  const appleProfile = {
    id: decodedUser.sub,
    accessToken: accessToken,
    gender: null,
    displayName: profile?.fullName?.nickName,
    name: profile?.name?.givenName,
    lastname: profile?.name?.familyName,
    email: decodedUser.email,
    emails: profile?.emails || [{value: decodedUser.email}],
    photos: profile?.photos?.map(photo => photo.value)
  };
  const ip = req.ip;
  return passportLogin(ip, 'apple', accessToken, refreshToken, appleProfile, done);
}

async function googleIdTokenLogin(req, res) {
  const client = new OAuth2Client();
  const id_token = req.query.id_token;
  async function verify() {
    const ticket = await client.verifyIdToken({
      idToken: id_token,
      audience: [process.env.GOOGLE_FIREBASE_SIGN_IN_APP_ID, process.env.GOOGLE_FIREBASE_WEB_CLIENT_ID]
      // Or, if multiple clients access the backend:
      //[CLIENT_ID_1, CLIENT_ID_2, CLIENT_ID_3]
    });
    return ticket.getPayload();
  }
  try {
    const profile = await verify();
    const googleProfile = {
      id: profile.sub,
      accessToken: id_token,
      gender: null,
      displayName: profile.name,
      name: profile?.given_name,
      lastname: profile?.family_name,
      email: profile.email,
      emails: [{ value: profile.email }],
      photos: [{ value: profile.picture }]
    };
    await googleLogin(req, id_token, null, googleProfile, (err, response) => {
      if (err) {
        console.error(err);
        res.status(500).json({message: "Something went wrong on Google Id Token login"});
        return;
      }
      if (response.authToken) res.json(response);
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({message: "Something went wrong on Google Id Token login"});
    return;
  }
}

async function createOrUpdateUser(accessToken, profile, type = 'facebook') {
  const fnMap = {
    facebook: {
      create: 'createUserFromFacebook',
      update: 'updateUserFromFacebook'
    },
    google: {
      create: 'createUserFromGoogle',
      update: 'updateUserFromGoogle'
    },
    apple: {
      create: 'createUserFromApple',
      update: 'updateUserFromApple'
    },
  };

  const mergedProfile = { ...profile, accessToken };
  const emails = profile.emails.map(email => email.value);
  const existingUser = await User.findOne({ email: { $in: emails } }).exec();

  const userModelFn = existingUser ? fnMap[type].update : fnMap[type].create;
  const user = await User[userModelFn](mergedProfile, existingUser);

  return user;
}

function activateUser(req, res) {
  const url = req.swagger.params.url.value;
  nev.confirmTempUser(url, function (err, user) {
    if (user) {
      nev.sendConfirmationEmail(user.email, function (err, info) {
        if (err) {
          return res.status(404).json({
            message: 'ERROR: sending confirmation email FAILED ' + info
          });
        }
        return res.status(200).json({
          success: 1,
          userid: user._id,
          message: 'CONFIRMED!'
        });
      });
    } else {
      return res.status(404).json({
        message: 'ERROR: confirming your temporary user FAILED, please try to login again',
        error: 'ERROR: confirming your temporary user FAILED, please try to login again'
      });
    }
  });
}

async function listUser(req, res) {
  const { search = '' } = req.query;
  const searchFields = ['name', 'author', 'email'];
  const query =
    search && search.length ? getORQuery(searchFields, search, true) : {};

  const response = await paginatedResponse(
    User,
    {
      query,
      populate: ['communicators']
    },
    req.query    
  );
  return res.status(200).json(response);
}

function removeUser(req, res) {
  const id = req.swagger.params.id.value;
  User.findByIdAndRemove(id, function (err, users) {
    if (err) {
      return res.status(404).json({
        message: 'User not found. User Id: ' + id
      });
    }
    return res.status(200).json(users);
  });
}

async function getUser(req, res) {
  const id = req.swagger.params.id.value;

  try {
    const user = await User.findById(id)
      .populate('communicators')
      .exec();

    if (!user) {
      return res.status(404).json({
        message: `User does not exist. User Id: ${id}`
      });
    }
    const settings = await getSettings(user);
    const response = {
      ...user.toJSON(),
      settings
    };

    return res.status(200).json(response);
  } catch (err) {
    return res.status(500).json({
      message: 'Error getting user.',
      error: err.message
    });
  }
}

const UPDATEABLE_FIELDS = [
  'email',
  'name',
  'birthdate',
  'profession',
  'matricule',
  'locale',
  'location',
  'isFirstLogin'
]

function updateUser(req, res) {
  console.log("here updateuser");
  const id = req.swagger.params.id.value;

  if (!req.user.isAdmin && req.auth.id !== id) {
    return res.status(403).json({
      message: 'You are not authorized to update this user.'
    });
  }
  console.log("here auth");
  User.findById(id)
    .populate('communicators')
    .exec(async function (err, user) {
      if (err) {
        return res.status(500).json({
          message: 'Error updating user.',
          error: err.message
        });
      }
      if (!user) {
        return res.status(404).json({
          message: 'Unable to find user. User Id: ' + id
        });
      }
      console.log("here find user");

      if (req.body.matricule) {
        const matriculeExists = await User.findOne({ matricule: req.body.matricule });
        console.log("findd or not",matriculeExists);
        
        // Si le matricule existe et que ce n'est pas le même utilisateur
        if (!matriculeExists) {
          console.log("dont enter");
            return res.status(400).json({
              message: "Le matricule n'existe pas pour un orthophoniste."
              
            });
          }
        }

      for (let key in req.body) {
        if (UPDATEABLE_FIELDS.includes(key)) {
          if (key === 'location') {
            if ((user.location && user.location.country) || isLocalIp(req.ip)) continue;
            try {
              req.body.location = await findIpLocation(req.ip);
            } catch (error) {
              console.error(error.message);
              continue;
            }
          }

          user[key] = req.body[key];
        }
      }

      try {
        const dbUser = await user.save();
        if (!dbUser) {
          return res.status(404).json({
            message: 'Unable to find user. User id: ' + id
          });
        }
        return res.status(200).json(user);
      } catch (e) {
        return res.status(500).json({
          message: 'Error saving user.',
          error: e.message
        });
      }
    });
}

async function getOrthoMatri(req, res) {
  console.log("getOrtho");

  const { matricule } = req.query; // Ensure matricule is correctly accessed from query
  console.log("matricule:", matricule);

  if (!matricule) {
    return res.status(400).json({ message: 'Matricule is required.' });
  }

  try {
    const users = await User.find({ matricule, profession: 'orthophoniste' }).exec();
    console.log("Orthophonistes found:", users);

    if (users.length === 0) {
      return res.status(404).json({ message: 'No orthophoniste found with the provided matricule.' });
    }
    return res.status(200).json(users);
  } catch (error) {
    console.error('Error fetching orthophonistes by matricule:', error);
    return res.status(500).json({ message: 'Error fetching orthophonistes.' });
  }
}

async function getMypatients(req, res) {
  console.log("getMypatients");

  const { matricule } = req.query; // Ensure matricule is correctly accessed from query
  console.log("matricule:", matricule);

  if (!matricule) {
    return res.status(400).json({ message: 'Matricule is required.' });
  }

  try {
    const patients = await User.find({ matricule, profession: 'patient' }).exec();
    console.log("Patients found:", patients);

    if (patients.length === 0) {
      return res.status(404).json({ message: 'No patients found with the provided matricule.' });
    }
    return res.status(200).json(patients);
  } catch (error) {
    console.error('Error fetching patients by matricule:', error);
    return res.status(500).json({ message: 'Error fetching patients.' });
  }
}




function loginUser(req, res) {
  const { email, password } = req.body;

  User.authenticate(email, password, async (error, user) => {
    if (error || !user) {
      console.error('error',error);
      return res.status(401).json({
        message: 'Wrong email or password.'
      });
    } else {
      const userId = user._id;
      req.session.userId = userId;

      const tokenString = auth.issueToken({
        email,
        id: userId
      });

      if (!user.location || !user.location.country)
        try {
          await updateUserLocation(req.ip, user);
        } catch (error) {
          console.error(error.message);
        }

      const settings = await getSettings(user);
      const subscriber = await getSubscriber(user);

      const response = {
        ...user.toJSON(),
        settings,
        subscriber,
        birthdate: moment(user.birthdate).format('YYYY-MM-DD'),
        authToken: tokenString
      };
      return res.status(200).json(response);
    }
  });
}

async function updateUserLocation(ip, user) {
  if ((!user.location || !user.location.country) && !isLocalIp(ip)) {
    try {
      const newLocation = await findIpLocation(ip);
      if (newLocation && newLocation.country) {
        user.location = newLocation;
        try {
          const dbUser = await user.save();
          if (!dbUser) {
            user.location = null;
            console.log("Unable to find user on the DB")
            return;
          }
        }
        catch (err) {
          console.log("Error saving user location", err)
          user.location = null;
          return;
        }
      }
    }
    catch (error) {
      console.error(error.message);
    }
  }
}


function logoutUser(req, res) {
  if (req.session) {
    // delete session object
    req.session.destroy(err => {
      if (err) {
        return res.status(500).json({
          message: 'Error removing session .',
          error: err.message
        });
      }
    });
  }

  return res.status(200).json({
    message: 'User successfully logout'
  });
}

async function getMe(req, res) {
  if (!req.user) {
    return res
      .status(400)
      .json({ message: 'Are you logged in? Is bearer token present?' });
  }

  const settings = await getSettings(req.user);
  const response = { ...req.user, settings };

  return res.status(200).json(response);
}

async function forgotPassword(req, res) {
  const { email } = req.body;
  try {
    const user = await User.findOne({ email: { $in: email } }).exec();
    if (!user) {
      return res.status(404).json({
        message: 'No user found with that email address. Check your input.'
      });
    }
    const resetPassword = await ResetPassword.findOne({
      userId: user.id,
      status: false
    }).exec();
    if (resetPassword) {
      //remove entry if exist
      await ResetPassword.deleteOne({ _id: resetPassword.id }, function (err) {
        if (err) {
          return res.status(500).json({
            message: 'ERROR: delete reset password FAILED ',
            error: err.message
          });
        }
      }).exec();
    }
    //creating the token to be sent to the forgot password form
    token = crypto.randomBytes(32).toString('hex');
    //hashing the password to store in the db node.js
    bcrypt.genSalt(8, function (err, salt) {
      bcrypt.hash(token, salt, function (err, hash) {
        const item = new ResetPassword({
          userId: user.id,
          resetPasswordToken: hash,
          resetPasswordExpires: moment.utc().add(86400, 'seconds'),
          status: false
        });
        item.save(function (err, rstPassword) {
          if (err) {
            return res.status(500).json({
              message: 'ERROR: create reset password FAILED ',
              error: err.message
            });
          }
        });
        //sending mail to the user where he can reset password.
        //User id, the token generated and user domain are sent as params in a link

        let domain = req.headers.origin;

        const isValidDomain = domain =>
        [CBOARD_PROD_URL, CBOARD_QA_URL, LOCALHOST_PORT_3000_URL].includes(domain);
        //if origin is private insert default hostname
        if (!domain || !isValidDomain(domain)) {
          domain = CBOARD_PROD_URL;
        }

        nev.sendResetPasswordEmail(user.email, domain, user.id, token, function (err) {
          if (err) {
            return res.status(500).json({
              message: 'ERROR: sending reset your password email FAILED ',
              error: err.message
            });
          } else {
            const response = {
              success: 1,
              userid: user.id,
              url: token,
              message: 'Success! Check your mail to reset your password.'
            };
            return res.status(200).json(response);
          }
        });
      });
    });
  } catch (err) {
    return res.status(500).json({
      message: 'Error resetting user password.',
      error: err.message
    });
  }
}
async function storePassword(req, res) {
  const { userid, password, token } = req.body;

  try {
    const resetPassword = await ResetPassword.findOne({
      userId: userid,
      status: false
    }).exec();
    if (!resetPassword) {
      return res.status(500).json({
        message: 'Expired time to reset password! ',
        error: err.message
      });
    }
    // the token and the hashed token in the db are verified befor updating the password
    bcrypt.compare(token, resetPassword.token, function (errBcrypt, resBcrypt) {
      let expireTime = moment.utc(resetPassword.expire);
      let currentTime = new Date();
      //hashing the password to store in the db node.js
      bcrypt.genSalt(8, function (err, salt) {
        bcrypt.hash(password, salt, async function (err, hash) {
          const user = await User.findOneAndUpdate(
            { _id: userid },
            { password: hash }
          );
          if (!user) {
            return res.status(404).json({
              message: 'No user found with that ID.'
            });
          }
          ResetPassword.findOneAndUpdate(
            { id: resetPassword.id },
            { status: true },
            function (err) {
              if (err) {
                return res.status(500).json({
                  message: 'ERROR: reset your password email FAILED ',
                  error: err.message
                });
              } else {
                const response = {
                  success: 1,
                  url: token,
                  message: 'Success! We have reset your password.'
                };
                return res.status(200).json(response);
              }
            }
          );
        });
      });
    });
  } catch (err) {
    return res.status(500).json({
      message: 'Error resetting user password.',
      error: err.message
    });
  }
}
